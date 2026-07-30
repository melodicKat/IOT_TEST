/* eslint-disable jsdoc/require-jsdoc, no-console */

const fs = require("node:fs");
const path = require("node:path");
const mqtt = require("mqtt");
const { chromium } = require("playwright");

const workspaceEnv = path.resolve(__dirname, "../../.env");
if (fs.existsSync(workspaceEnv)) process.loadEnvFile(workspaceEnv);

const host = process.env.SECRET_HIVEMQ_HOST || process.env.HIVEMQ_HOST;
const username = process.env.SECRET_ESP32_MQTT_USERNAME || process.env.MQTT_USER;
const password = process.env.SECRET_ESP32_MQTT_PASSWORD || process.env.MQTT_PASS;
const topicPrefix = process.env.SECRET_MQTT_TOPIC_PREFIX || process.env.MQTT_TOPIC_PREFIX || "smartmirror/team01";

if (!host?.endsWith(".hivemq.cloud") || !username || !password) {
	throw new Error("QA requires valid HiveMQ settings in ../.env");
}

function findInstalledChromium () {
	const cache = path.join(process.env.LOCALAPPDATA || "", "ms-playwright");
	if (!fs.existsSync(cache)) return undefined;
	const candidates = fs.readdirSync(cache)
		.filter((name) => name.startsWith("chromium_headless_shell-"))
		.sort()
		.reverse();
	for (const directory of candidates) {
		const executable = path.join(cache, directory, "chrome-headless-shell-win64", "chrome-headless-shell.exe");
		if (fs.existsSync(executable)) return executable;
	}
	return undefined;
}

function publish (client, topic, payload) {
	return new Promise((resolve, reject) => {
		client.publish(topic, payload, { qos: 0, retain: false }, (error) => (error ? reject(error) : resolve()));
	});
}

function measureLayout (page) {
	return page.evaluate(() => {
		const visibleModules = [...document.querySelectorAll(".module")]
			.filter((element) => {
				const style = getComputedStyle(element);
				const rect = element.getBoundingClientRect();
				return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
			})
			.map((element) => ({
				name: [...element.classList].filter((item) => item !== "module").join("."),
				rect: element.getBoundingClientRect().toJSON()
			}));
		const overlaps = [];
		for (let left = 0; left < visibleModules.length; left += 1) {
			for (let right = left + 1; right < visibleModules.length; right += 1) {
				const a = visibleModules[left];
				const b = visibleModules[right];
				if (a.rect.left < b.rect.right && a.rect.right > b.rect.left && a.rect.top < b.rect.bottom && a.rect.bottom > b.rect.top) {
					overlaps.push(`${a.name} <> ${b.name}`);
				}
			}
		}
		const edgeHeader = document.querySelector(".esp32-card-header")?.getBoundingClientRect();
		const edgeMetrics = document.querySelector(".esp32-metrics")?.getBoundingClientRect();
		const leftRail = document.querySelector(".region.top.left")?.getBoundingClientRect();
		const rightRail = document.querySelector(".region.top.right")?.getBoundingClientRect();
		return {
			viewport: [innerWidth, innerHeight],
			moduleCount: visibleModules.length,
			overlaps,
			centerClearWidth: leftRail && rightRail ? Math.max(0, rightRail.left - leftRail.right) : 0,
			edgeHeaderSeparated: Boolean(edgeHeader && edgeMetrics && edgeHeader.bottom <= edgeMetrics.top),
			edgeInsideWidth: visibleModules
				.filter((item) => item.name.includes("MMM-ESP32Bridge"))
				.every((item) => item.rect.left >= 0 && item.rect.right <= innerWidth)
		};
	});
}

async function main () {
	const browser = await chromium.launch({ headless: true, executablePath: findInstalledChromium() });
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	page.on("pageerror", (error) => console.error(`[PAGE] ${error.message}`));
	page.on("console", (message) => {
		if (message.type() === "error") console.error(`[BROWSER] ${message.text()}`);
	});
	await page.goto("http://localhost:8080", { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(3000);

	const client = mqtt.connect(`wss://${host}:8884/mqtt`, {
		username,
		password,
		rejectUnauthorized: true,
		connectTimeout: 10000
	});
	await new Promise((resolve, reject) => {
		client.once("connect", resolve);
		client.once("error", reject);
	});

	try {
		await publish(client, `${topicPrefix}/status`, JSON.stringify({ online: true, led: "ON", reason: "qa" }));
		await publish(client, `${topicPrefix}/telemetry/temperature`, "26.4");
		await publish(client, `${topicPrefix}/telemetry/humidity`, "63.2");
		await publish(client, `${topicPrefix}/telemetry/presence`, "1");
		await publish(client, `${topicPrefix}/telemetry/ambient-light`, "42");
		await page.waitForTimeout(1000);

		await publish(client, `${topicPrefix}/event/button`, JSON.stringify({
			event: "pressed",
			source: "button",
			gesture: "tap",
			sequence: 999,
			view: "calendar",
			uptimeMs: 12345
		}));
		await page.waitForFunction(() => document.body.classList.contains("esp32-calendar-mode"), undefined, { timeout: 5000 });
		const calendarMode = await page.evaluate(() => document.body.classList.contains("esp32-calendar-mode"));

		await publish(client, `${topicPrefix}/event/button`, JSON.stringify({
			event: "touch",
			source: "touch",
			gesture: "doubleTap",
			sequence: 1000,
			view: "settings",
			uptimeMs: 13000
		}));
		await page.waitForFunction(() => document.body.classList.contains("esp32-settings-mode"), undefined, { timeout: 5000 });
		await page.waitForTimeout(700);
		const settingsMode = await page.evaluate(() => {
			const rows = [...document.querySelectorAll(".esp32-setting-row")].map((element) => element.getBoundingClientRect());
			let overlaps = 0;
			for (let left = 0; left < rows.length; left += 1) {
				for (let right = left + 1; right < rows.length; right += 1) {
					const a = rows[left];
					const b = rows[right];
					if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) overlaps += 1;
				}
			}
			return {
				active: document.body.classList.contains("esp32-settings-mode"),
				controls: rows.length,
				sections: document.querySelectorAll(".esp32-settings-section").length,
				overlaps,
				bodyBackgroundImage: getComputedStyle(document.body).backgroundImage,
				networkProfile: document.querySelector(".esp32-network-field input")?.value || "",
				networkDetails: document.querySelector(".esp32-network-section")?.innerText || ""
			};
		});
		await page.locator("select[aria-label=\"Định dạng giờ\"]").selectOption("12");
		await page.locator("select[aria-label=\"Ngưỡng Edge offline\"]").selectOption("30");
		await page.locator(".esp32-settings-panel").evaluate((element) => {
			element.scrollTop = element.scrollHeight;
		});
		const networkGeometry = await page.evaluate(() => {
			const panel = document.querySelector(".esp32-settings-panel");
			const button = [...document.querySelectorAll("button")].find((element) => element.textContent === "KIỂM TRA KẾT NỐI");
			const buttonRect = button.getBoundingClientRect();
			return {
				viewport: [innerWidth, innerHeight],
				scroll: [panel.scrollTop, panel.scrollHeight, panel.clientHeight],
				panel: panel.getBoundingClientRect().toJSON(),
				button: buttonRect.toJSON(),
				buttonInViewport: buttonRect.left >= 0 && buttonRect.top >= 0 && buttonRect.right <= innerWidth && buttonRect.bottom <= innerHeight
			};
		});
		await page.getByRole("button", { name: "KIỂM TRA KẾT NỐI" }).click();
		const networkCheck = await page.locator(".esp32-network-actions [role=\"status\"]").innerText();
		const savedSettings = await page.evaluate(() => JSON.parse(localStorage.getItem("smartmirror.ui.settings") || "{}"));

		await publish(client, `${topicPrefix}/event/button`, JSON.stringify({
			event: "touch",
			source: "touch",
			gesture: "longPress",
			sequence: 1001,
			view: "mirror",
			uptimeMs: 14000
		}));
		await page.waitForFunction(() => document.body.classList.contains("esp32-mirror-mode"), undefined, { timeout: 5000 });
		const mirrorMode = await page.evaluate(() => document.body.classList.contains("esp32-mirror-mode"));

		await publish(client, `${topicPrefix}/event/button`, JSON.stringify({
			event: "touch",
			source: "touch",
			gesture: "tap",
			sequence: 1002,
			view: "normal",
			uptimeMs: 15000
		}));
		await page.waitForFunction(
			() => !document.body.classList.contains("esp32-calendar-mode")
			  && !document.body.classList.contains("esp32-mirror-mode")
			  && !document.body.classList.contains("esp32-settings-mode"),
			undefined,
			{ timeout: 5000 }
		);
		await page.waitForTimeout(700);

		await page.keyboard.press("2");
		await page.waitForFunction(() => document.body.classList.contains("esp32-calendar-mode"), undefined, { timeout: 5000 });
		const keyboardCalendarMode = await page.evaluate(() => document.body.classList.contains("esp32-calendar-mode"));
		await page.keyboard.press("3");
		await page.waitForFunction(() => document.body.classList.contains("esp32-mirror-mode"), undefined, { timeout: 5000 });
		const keyboardMirrorMode = await page.evaluate(() => document.body.classList.contains("esp32-mirror-mode"));
		await page.keyboard.press("4");
		await page.waitForFunction(() => document.body.classList.contains("esp32-settings-mode"), undefined, { timeout: 5000 });
		const keyboardSettingsMode = await page.evaluate(() => document.body.classList.contains("esp32-settings-mode"));
		await page.keyboard.press("Escape");
		await page.waitForFunction(
			() => !document.body.classList.contains("esp32-calendar-mode")
			  && !document.body.classList.contains("esp32-mirror-mode")
			  && !document.body.classList.contains("esp32-settings-mode"),
			undefined,
			{ timeout: 5000 }
		);
		await publish(client, `${topicPrefix}/telemetry/temperature`, "26.4");
		await publish(client, `${topicPrefix}/telemetry/humidity`, "63.2");
		await page.waitForTimeout(700);

		const result = await page.evaluate(() => ({
			text: document.querySelector(".MMM-ESP32Bridge")?.innerText?.replace(/\s+/g, " ").trim() || "",
			normal: !document.body.classList.contains("esp32-calendar-mode")
			  && !document.body.classList.contains("esp32-mirror-mode")
			  && !document.body.classList.contains("esp32-settings-mode"),
			weatherModules: document.querySelectorAll(".module.weather").length,
			weatherText: [...document.querySelectorAll(".module.weather")]
				.map((element) => element.innerText.replace(/\s+/g, " ").trim())
				.join(" | ")
		}));
		const desktopLayout = await measureLayout(page);
		await page.setViewportSize({ width: 800, height: 1200 });
		await page.waitForTimeout(350);
		const responsiveLayout = await measureLayout(page);
		const passed = calendarMode
		  && mirrorMode
		  && settingsMode.active
		  && settingsMode.controls >= 18
		  && settingsMode.sections >= 8
		  && settingsMode.overlaps === 0
		  && settingsMode.bodyBackgroundImage === "none"
		  && settingsMode.networkProfile === "Wokwi-GUEST"
		  && settingsMode.networkDetails.includes("WSS / TLS")
		  && networkGeometry.buttonInViewport
		  && networkCheck.includes("MQTT bridge đang")
		  && savedSettings.timeFormat === 12
		  && savedSettings.offlineAfterSeconds === 30
		  && result.normal
		  && keyboardCalendarMode
		  && keyboardMirrorMode
		  && keyboardSettingsMode
		  && result.weatherModules === 2
		  && desktopLayout.overlaps.length === 0
		  && desktopLayout.centerClearWidth >= 100
		  && desktopLayout.edgeHeaderSeparated
		  && desktopLayout.edgeInsideWidth
		  && responsiveLayout.overlaps.length === 0
		  && responsiveLayout.edgeHeaderSeparated
		  && responsiveLayout.edgeInsideWidth
		  && (/\d+(?:[.,]\d+)?°/).test(result.weatherText)
		  && result.text.includes("26.4°C")
		  && result.text.includes("63.2%")
		  && result.text.includes("PIR · CÓ NGƯỜI")
		  && result.text.includes("LDR · 42 LUX")
		  && result.text.includes("LỊCH SỬ 24 GIỜ")
		  && result.text.includes("Cảm ứng #1002: TAP · TỔNG QUAN");
		console.log(JSON.stringify({
			syntheticCloudToMirror: passed,
			calendarMode,
			mirrorMode,
			settingsMode,
			normalMode: result.normal,
			keyboardCalendarMode,
			keyboardMirrorMode,
			keyboardSettingsMode,
			networkGeometry,
			networkCheck,
			savedSettings,
			desktopLayout,
			responsiveLayout,
			weatherModules: result.weatherModules,
			weatherText: result.weatherText,
			renderedText: result.text
		}));
		if (!passed) throw new Error("MagicMirror did not render the expected MQTT values");
	} finally {
		await publish(client, `${topicPrefix}/status`, JSON.stringify({ online: false, led: "OFF", reason: "qa-complete" }));
		client.end(true);
		await browser.close();
	}
}

main().catch((error) => {
	console.error(`Bridge QA failed: ${error.message}`);
	process.exitCode = 1;
});
