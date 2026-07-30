const fs = require("node:fs");
const path = require("node:path");

const workspaceEnv = path.resolve(__dirname, "../../.env");
if (fs.existsSync(workspaceEnv)) {
	process.loadEnvFile(workspaceEnv);
}

// Compatibility with the original non-SECRET names while ensuring that
// MagicMirror's hideConfigSecrets mechanism only exposes **SECRET_...** tokens.
const aliases = {
	SECRET_HIVEMQ_HOST: "HIVEMQ_HOST",
	SECRET_HIVEMQ_TCP_PORT: "HIVEMQ_PORT",
	SECRET_ESP32_MQTT_USERNAME: "MQTT_USER",
	SECRET_ESP32_MQTT_PASSWORD: "MQTT_PASS",
	SECRET_MIRROR_MQTT_USERNAME: "MQTT_USER",
	SECRET_MIRROR_MQTT_PASSWORD: "MQTT_PASS",
	SECRET_OPENWEATHERMAP_API_KEY: "OPENWEATHERMAP_API_KEY",
	SECRET_GOOGLE_CALENDAR_ICS_URL: "GOOGLE_CALENDAR_ICS_URL",
	SECRET_TELEGRAM_BOT_TOKEN: "TELEGRAM_BOT_TOKEN",
	SECRET_TELEGRAM_CHAT_ID: "TELEGRAM_CHAT_ID",
	SECRET_GMAIL_USER: "GMAIL_USER",
	SECRET_GMAIL_APP_PASSWORD: "GMAIL_APP_PASSWORD",
	SECRET_GMAIL_TO: "GMAIL_TO",
	SECRET_FIREBASE_SERVICE_ACCOUNT_B64: "FIREBASE_SERVICE_ACCOUNT_B64"
};

for (const [secretName, legacyName] of Object.entries(aliases)) {
	if (!process.env[secretName] && process.env[legacyName]) {
		process.env[secretName] = process.env[legacyName];
	}
}

process.env.SECRET_HIVEMQ_TCP_PORT ||= "8883";
process.env.SECRET_HIVEMQ_WS_PORT ||= "8884";
process.env.SECRET_MQTT_TOPIC_PREFIX ||= process.env.MQTT_TOPIC_PREFIX || "smartmirror/team01";
process.env.ALERT_TEMP_HIGH_C ||= "30";
process.env.ALERT_HUMIDITY_HIGH_PCT ||= "80";
process.env.ALERT_COOLDOWN_MINUTES ||= "15";
process.env.ALERT_TELEGRAM_ENABLED ||= "false";
process.env.ALERT_GMAIL_ENABLED ||= "false";
process.env.HISTORY_SAMPLE_SECONDS ||= "60";
process.env.FIREBASE_ENABLED ||= "false";
process.env.FIREBASE_PROJECT_ID ||= "disabled-project";
process.env.FIREBASE_COLLECTION ||= "smartmirrorTelemetry";

require("../serveronly");
