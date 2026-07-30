/* eslint-disable no-console */

const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
	url: "http://localhost:8080"
});
global.window = dom.window;
global.document = dom.window.document;
global.Log = { info: () => {} };
global.requestAnimationFrame = (callback) => callback();

let definition;
global.Module = {
	register: (name, moduleDefinition) => {
		assert.equal(name, "MMM-CalendarAgenda");
		definition = moduleDefinition;
	}
};
require("../modules/MMM-CalendarAgenda/MMM-CalendarAgenda");

const agenda = Object.create(definition);
agenda.name = "MMM-CalendarAgenda";
agenda.config = { ...definition.defaults, maximumEntries: 1 };
let renderCount = 0;
const sentNotifications = [];
agenda.updateDom = () => {
	renderCount += 1;
};
agenda.sendNotification = (name, payload) => {
	sentNotifications.push({ name, payload });
};
agenda.start();

const now = Date.now();
const event = (offsetHours, title, extra = {}) => ({
	title,
	startDate: String(now + offsetHours * 60 * 60 * 1000),
	endDate: String(now + (offsetHours + 1) * 60 * 60 * 1000),
	fullDayEvent: false,
	location: false,
	description: false,
	calendarName: "Lịch cá nhân",
	color: "#8ab4f8",
	...extra
});

try {
	agenda.notificationReceived("CALENDAR_EVENTS", [
		event(4, "Sự kiện 4 không được hiển thị"),
		event(1, "<img src=x onerror=alert(1)> Họp dự án", {
			location: "Phòng họp A",
			description: "Chuẩn bị báo cáo\nMang theo tài liệu"
		}),
		event(3, "Sự kiện 3"),
		event(2, "Sự kiện 2")
	], { name: "calendar" });

	assert.equal(renderCount, 1);
	assert.equal(agenda.events.length, 1);
	assert.equal(agenda.allEvents.length, 4);
	const dashboard = agenda.getDom();
	document.body.appendChild(dashboard);
	const overviewButtons = dashboard.querySelectorAll(".calendar-agenda-overview .calendar-agenda-event");
	assert.equal(overviewButtons.length, 1);
	assert.match(overviewButtons[0].textContent, /Họp dự án/);
	assert.equal(overviewButtons[0].querySelector("img"), null, "event titles must render as text");
	assert.equal(dashboard.querySelector(".calendar-workspace"), null, "the overview must not contain the full-screen workspace");

	overviewButtons[0].click();
	assert.ok(agenda.selectedEvent);
	const dialog = document.body.querySelector("[role=\"dialog\"]");
	assert.ok(dialog);
	assert.equal(dialog.closest(".calendar-agenda-backdrop").parentElement, document.body);
	assert.match(dialog.textContent, /Phòng họp A/);
	assert.match(dialog.textContent, /Chuẩn bị báo cáo/);
	assert.match(dialog.textContent, /Lịch cá nhân/);

	dialog.querySelector(".calendar-agenda-dialog-close").click();
	assert.equal(agenda.selectedEvent, null);

	agenda.openDetails(agenda.events[0]);
	document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape" }));
	assert.equal(agenda.selectedEvent, null);

	agenda.notificationReceived("ESP32_VIEW_MODE_CHANGED", { mode: "calendar" }, { name: "MMM-ESP32Bridge" });
	let workspacePortal = document.body.querySelector(".calendar-workspace-portal");
	assert.ok(workspacePortal, "Calendar mode must mount a body-level workspace portal");
	assert.equal(workspacePortal.parentElement, document.body);
	assert.equal(workspacePortal.querySelectorAll(".calendar-month-day").length, 42);
	assert.equal(workspacePortal.querySelectorAll(".calendar-workspace-tab").length, 3);
	assert.deepEqual(
		[...workspacePortal.querySelector(".calendar-workspace-toolbar").children].map((element) => element.className),
		["calendar-workspace-navigation", "calendar-workspace-title", "calendar-workspace-tabs"],
		"navigation, centered title and view tabs must be independent toolbar columns"
	);

	agenda.setCalendarView("week");
	workspacePortal = document.body.querySelector(".calendar-workspace-portal");
	assert.equal(workspacePortal.querySelectorAll(".calendar-week-day-label").length, 7);
	assert.equal(workspacePortal.querySelectorAll(".calendar-week-column").length, 7);
	const weekScroll = workspacePortal.querySelector(".calendar-week-scroll");
	assert.equal(workspacePortal.querySelector(".calendar-week-header").parentElement, weekScroll);
	assert.equal(workspacePortal.querySelector(".calendar-week-all-day").parentElement, weekScroll);
	assert.equal(workspacePortal.querySelector(".calendar-week-timeline").parentElement, weekScroll);

	agenda.setCalendarView("year");
	workspacePortal = document.body.querySelector(".calendar-workspace-portal");
	assert.equal(workspacePortal.querySelectorAll(".calendar-year-month").length, 12);
	workspacePortal.querySelector(".calendar-workspace-close").click();
	assert.deepEqual(sentNotifications.at(-1), {
		name: "ESP32_VIEW_MODE_REQUEST",
		payload: { mode: "normal" }
	});

	agenda.notificationReceived("ESP32_VIEW_MODE_CHANGED", { mode: "normal" }, { name: "MMM-ESP32Bridge" });
	assert.equal(document.body.querySelector(".calendar-workspace-portal"), null);
	console.log("One-event overview, portal calendar views and body-level detail dialog tests passed");
} finally {
	agenda.stop();
	dom.window.close();
}
