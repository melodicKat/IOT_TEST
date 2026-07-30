/* eslint-disable no-console, jsdoc/require-jsdoc */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const workspaceDirectory = path.resolve(__dirname, "../..");
const firmwareDirectory = path.join(workspaceDirectory, "firmware");
const scenarioDirectory = path.join(firmwareDirectory, "scenarios");
const envFile = path.join(workspaceDirectory, ".env");

const catalog = Object.freeze({
	"realistic-day": {
		file: "realistic-day.yaml",
		timeoutMs: 120_000,
		description: "90-110s: nhiệt độ, LDR/auto-dim, cảnh báo nóng và ẩm"
	},
	"sensor-check": {
		file: "sensor-check.yaml",
		timeoutMs: 70_000,
		description: "45-60s: kiểm tra nhanh DHT22, LDR, OLED, MQTT và Rule Engine"
	},
	"hot-humid-alert": {
		file: "hot-humid-alert.yaml",
		timeoutMs: 70_000,
		description: "Kiểm tra riêng ngưỡng cảnh báo nóng/ẩm"
	},
	"network-recovery": {
		file: "network-recovery.yaml",
		timeoutMs: 70_000,
		description: "Kiểm tra WiFi/MQTT offline và reconnect"
	},
	"touch-interactions": {
		file: "touch-interactions.yaml",
		timeoutMs: 50_000,
		description: "Kiểm tra tap, double tap và long press"
	}
});

if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

function usage () {
	console.log(`
Demo Wokwi end-to-end: sensor -> firmware/OLED -> HiveMQ -> MagicMirror

  npm run demo:data
  npm run demo:wokwi -- --scenario sensor-check
  npm run demo:day
  npm run demo:wokwi -- --list

Tùy chọn:
  --scenario <name>     Kịch bản Wokwi, mặc định realistic-day
  --engine <sdk|cli>    Bộ chạy Wokwi, mặc định SDK (CLI là dự phòng)
  --timeout-ms <n>      Giới hạn mô phỏng, tối đa 180000ms
  --no-build            Dùng lại firmware đã build
  --skip-mirror-check   Không kiểm tra localhost:8080
  --dry-run             Chỉ kiểm tra và in lệnh, không chạy Wokwi
  --list                Liệt kê kịch bản
`);
}

function readValue (arguments_, index, flag) {
	const value = arguments_[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${flag} cần một giá trị`);
	return value;
}

function parseArguments (arguments_) {
	const options = {
		scenario: "realistic-day",
		engine: "sdk",
		timeoutMs: null,
		build: true,
		checkMirror: true,
		dryRun: false,
		list: false
	};
	for (let index = 0; index < arguments_.length; index += 1) {
		const argument = arguments_[index];
		if (argument === "--scenario") {
			options.scenario = readValue(arguments_, index, argument);
			index += 1;
		} else if (argument === "--engine") {
			options.engine = readValue(arguments_, index, argument);
			index += 1;
		} else if (argument === "--timeout-ms") {
			options.timeoutMs = Number(readValue(arguments_, index, argument));
			index += 1;
		} else if (argument === "--no-build") {
			options.build = false;
		} else if (argument === "--skip-mirror-check") {
			options.checkMirror = false;
		} else if (argument === "--dry-run") {
			options.dryRun = true;
		} else if (argument === "--list") {
			options.list = true;
		} else if (argument === "--help" || argument === "-h") {
			usage();
			process.exit(0);
		} else {
			throw new Error(`Tùy chọn không hỗ trợ: ${argument}`);
		}
	}
	if (!catalog[options.scenario]) throw new Error(`Không tìm thấy scenario "${options.scenario}"`);
	if (!["sdk", "cli"].includes(options.engine)) throw new Error("--engine chỉ nhận sdk hoặc cli");
	if (options.timeoutMs !== null && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 10_000 || options.timeoutMs > 180_000)) {
		throw new Error("--timeout-ms phải là số nguyên trong khoảng 10000..180000");
	}
	return options;
}

function run (command, arguments_, options = {}) {
	const result = spawnSync(command, arguments_, {
		cwd: options.cwd || workspaceDirectory,
		env: options.env || process.env,
		stdio: options.quiet ? "ignore" : "inherit",
		shell: false,
		timeout: options.timeoutMs
	});
	if (result.error) {
		if (options.allowMissing && result.error.code === "ENOENT") return null;
		if (result.error.code === "ETIMEDOUT") {
			throw new Error(`Tiến trình ${path.basename(command)} không phản hồi trong ${options.timeoutMs}ms`);
		}
		throw result.error;
	}
	return result.status;
}

function platformIoCommand () {
	const candidates = process.platform === "win32"
		? [
			{ command: "py", prefix: ["-m", "platformio"] },
			{ command: "python", prefix: ["-m", "platformio"] },
			{ command: "pio", prefix: [] }
		]
		: [
			{ command: "python3", prefix: ["-m", "platformio"] },
			{ command: "python", prefix: ["-m", "platformio"] },
			{ command: "pio", prefix: [] }
		];
	for (const candidate of candidates) {
		const status = run(candidate.command, [...candidate.prefix, "--version"], {
			cwd: firmwareDirectory,
			quiet: true,
			allowMissing: true
		});
		if (status === 0) return candidate;
	}
	throw new Error("Không tìm thấy PlatformIO Core. Hãy cài extension PlatformIO IDE trong VS Code.");
}

function wokwiCommand () {
	const configured = String(process.env.WOKWI_CLI_PATH || "").trim();
	if (configured) return configured;
	const workspaceBinary = path.join(workspaceDirectory, ".tools", process.platform === "win32" ? "wokwi-cli.exe" : "wokwi-cli");
	if (fs.existsSync(workspaceBinary)) return workspaceBinary;
	const userDirectory = String(process.env.USERPROFILE || process.env.HOME || "").trim();
	const officialBinary = userDirectory
		? path.join(userDirectory, ".wokwi", "bin", process.platform === "win32" ? "wokwi-cli.exe" : "wokwi-cli")
		: "";
	if (officialBinary && fs.existsSync(officialBinary)) return officialBinary;
	const status = run("wokwi-cli", ["--version"], { quiet: true, allowMissing: true });
	if (status === null) {
		throw new Error(
			"Không tìm thấy Wokwi CLI. Trên PowerShell chạy: "
			+ "iwr https://wokwi.com/ci/install.ps1 -useb | iex"
		);
	}
	return "wokwi-cli";
}

function systemPythonCommand () {
	const candidates = process.platform === "win32"
		? [
			{ command: "py", prefix: [] },
			{ command: "python", prefix: [] }
		]
		: [
			{ command: "python3", prefix: [] },
			{ command: "python", prefix: [] }
		];
	for (const candidate of candidates) {
		const status = run(candidate.command, [...candidate.prefix, "--version"], {
			quiet: true,
			allowMissing: true
		});
		if (status === 0) return candidate;
	}
	throw new Error("Không tìm thấy Python 3 để chạy Wokwi SDK.");
}

function ensureWokwiSdk () {
	const virtualEnvironment = path.join(workspaceDirectory, ".tools", "wokwi-venv");
	const python = process.platform === "win32"
		? path.join(virtualEnvironment, "Scripts", "python.exe")
		: path.join(virtualEnvironment, "bin", "python");
	const importArguments = ["-c", "import yaml, wokwi_client"];
	if (fs.existsSync(python) && run(python, importArguments, { quiet: true }) === 0) return python;

	const systemPython = systemPythonCommand();
	console.log("[SDK] Đang tạo môi trường Python miễn phí trong .tools/wokwi-venv...");
	const venvStatus = run(systemPython.command, [...systemPython.prefix, "-m", "venv", virtualEnvironment]);
	if (venvStatus !== 0) throw new Error(`Không thể tạo Python venv (exit ${venvStatus})`);
	const requirements = path.join(firmwareDirectory, "requirements-demo.txt");
	const installStatus = run(python, [
		"-m",
		"pip",
		"install",
		"--disable-pip-version-check",
		"-r",
		requirements
	]);
	if (installStatus !== 0) throw new Error(`Không thể cài Wokwi SDK (exit ${installStatus})`);
	return python;
}

async function mirrorReady () {
	try {
		const response = await fetch("http://localhost:8080", {
			signal: AbortSignal.timeout(2500),
			redirect: "follow"
		});
		return response.ok;
	} catch {
		return false;
	}
}

function listScenarios () {
	for (const [name, item] of Object.entries(catalog)) {
		const exists = fs.existsSync(path.join(scenarioDirectory, item.file));
		console.log(`${exists ? "READY" : "MISSING"}  ${name.padEnd(20)} ${item.description}`);
	}
}

async function main () {
	const options = parseArguments(process.argv.slice(2));
	if (options.list) {
		listScenarios();
		return;
	}

	const item = catalog[options.scenario];
	const scenarioPath = path.join(scenarioDirectory, item.file);
	if (!fs.existsSync(scenarioPath)) throw new Error(`Thiếu ${scenarioPath}`);
	const timeoutMs = options.timeoutMs ?? item.timeoutMs;

	if (options.checkMirror && !(await mirrorReady())) {
		throw new Error(
			"MagicMirror chưa chạy ở http://localhost:8080. "
			+ "Mở terminal khác trong mirror/ và chạy: npm start server"
		);
	}

	console.log(`Scenario : ${options.scenario}`);
	console.log("Luồng    : Wokwi sensor -> ESP32/OLED -> MQTT/TLS -> Mirror");
	console.log("Timing   : DHT22 <= 2s, LDR <= 0.5s, giao diện <= 0.4s; mục tiêu E2E <= 3s");
	console.log("Quan sát : http://localhost:8080");
	const temperatureThreshold = Number(process.env.ALERT_TEMP_HIGH_C || 30);
	const humidityThreshold = Number(process.env.ALERT_HUMIDITY_HIGH_PCT || 80);
	console.log(`Rule     : nhiệt độ > ${temperatureThreshold}°C, độ ẩm > ${humidityThreshold}%`);
	const externalChannels = [
		String(process.env.ALERT_TELEGRAM_ENABLED).toLowerCase() === "true" ? "Telegram" : "",
		String(process.env.ALERT_GMAIL_ENABLED).toLowerCase() === "true" ? "Gmail" : ""
	].filter(Boolean);
	console.log(`Cảnh báo : ${externalChannels.length > 0 ? `${externalChannels.join(" + ")} đang bật` : "chỉ hiển thị trên Mirror"}`);
	if (["realistic-day", "sensor-check"].includes(options.scenario) && (temperatureThreshold !== 30 || humidityThreshold !== 80)) {
		console.warn("Lưu ý: scenario được thiết kế cho ngưỡng mặc định 30°C/80%; hãy đặt lại Settings trước khi demo.");
	}

	if (options.dryRun) {
		console.log(`Dry-run  : firmware/scenarios/${item.file}, engine ${options.engine}, timeout ${timeoutMs}ms`);
		return;
	}

	if (options.build) {
		const platformio = platformIoCommand();
		console.log("\n[1/2] Building ESP32 firmware...");
		const buildStatus = run(platformio.command, [...platformio.prefix, "run"], { cwd: firmwareDirectory });
		if (buildStatus !== 0) throw new Error(`PlatformIO build thất bại (exit ${buildStatus})`);
	}

	const token = String(process.env.WOKWI_CLI_TOKEN || process.env.SECRET_WOKWI_CLI_TOKEN || "").trim();
	if (!token) {
		throw new Error(
			"Thiếu Wokwi CI token miễn phí. Thêm SECRET_WOKWI_CLI_TOKEN vào .env "
			+ "(lấy tại https://wokwi.com/dashboard/ci)."
		);
	}

	const serialLog = path.join(firmwareDirectory, ".pio", `demo-${options.scenario}-serial.log`);
	const childEnvironment = { ...process.env, WOKWI_CLI_TOKEN: token };
	console.log(`\n[2/2] Running Wokwi sensor automation (${options.engine.toUpperCase()})...`);
	let status;
	if (options.engine === "sdk") {
		const python = ensureWokwiSdk();
		status = run(python, [
			path.join("scripts", "wokwi_sdk_demo.py"),
			"--scenario",
			path.relative(firmwareDirectory, scenarioPath),
			"--serial-log-file",
			serialLog
		], { cwd: firmwareDirectory, env: childEnvironment, timeoutMs: timeoutMs + 60_000 });
	} else {
		const command = wokwiCommand();
		status = run(command, [
			".",
			"--scenario",
			path.relative(firmwareDirectory, scenarioPath),
			"--timeout",
			String(timeoutMs),
			"--serial-log-file",
			serialLog
		], { cwd: firmwareDirectory, env: childEnvironment, timeoutMs: timeoutMs + 60_000 });
	}
	if (status !== 0) throw new Error(`Wokwi scenario thất bại (exit ${status})`);
	console.log(`\nHoàn tất. Serial log: ${path.relative(workspaceDirectory, serialLog)}`);
}

main().catch((error) => {
	console.error(`Demo thất bại: ${error.message}`);
	process.exitCode = 1;
});
