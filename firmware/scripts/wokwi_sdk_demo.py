"""Run Wokwi automation scenarios through the official Wokwi Python SDK.

This is the reliable fallback for environments where wokwi-cli connects but
stalls before starting the simulation. Sensor values are still changed inside
Wokwi: scenario -> set_control -> virtual sensor -> ESP32 firmware -> MQTT.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

import yaml
from wokwi_client import FlashSection, WokwiClient


CONNECT_TIMEOUT_SECONDS = 25
UPLOAD_TIMEOUT_SECONDS = 40
START_TIMEOUT_SECONDS = 40
WAIT_SERIAL_TIMEOUT_SECONDS = 45
CONTROL_TIMEOUT_SECONDS = 10


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a Wokwi YAML scenario via the SDK")
    parser.add_argument("--scenario", required=True, type=Path)
    parser.add_argument("--serial-log-file", required=True, type=Path)
    return parser.parse_args()


def parse_duration(value: Any) -> float:
    if isinstance(value, (int, float)):
        return float(value) / 1000
    match = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*(ms|s)\s*", str(value))
    if not match:
        raise ValueError(f"Unsupported delay value: {value!r}")
    amount = float(match.group(1))
    return amount / 1000 if match.group(2) == "ms" else amount


class SerialCapture:
    def __init__(self, log_path: Path) -> None:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        self._log = log_path.open("w", encoding="utf-8", newline="")
        self._buffer = ""

    def close(self) -> None:
        self._log.close()

    def feed(self, payload: bytes) -> None:
        text = payload.decode("utf-8", errors="replace")
        self._buffer = (self._buffer + text)[-100_000:]
        self._log.write(text)
        self._log.flush()
        print(text, end="", flush=True)

    def contains(self, expected: str) -> bool:
        return expected in self._buffer


async def run_step(
    client: WokwiClient,
    serial: SerialCapture,
    step: dict[str, Any],
    current_simulation_seconds: float,
) -> float:
    if "set-control" in step:
        control = step["set-control"]
        part = str(control["part-id"])
        name = str(control["control"])
        value = control["value"]
        print(f"\n[SCENARIO] {part}.{name} = {value}", flush=True)
        await asyncio.wait_for(
            client.set_control(part, name, value),
            timeout=CONTROL_TIMEOUT_SECONDS,
        )
        return current_simulation_seconds

    if "wait-serial" in step:
        expected = str(step["wait-serial"])
        print(f"\n[SCENARIO] Waiting for serial: {expected}", flush=True)
        deadline = time.monotonic() + WAIT_SERIAL_TIMEOUT_SECONDS
        target = max(
            current_simulation_seconds,
            client.last_pause_nanos / 1_000_000_000,
        )
        while not serial.contains(expected):
            if time.monotonic() >= deadline:
                raise TimeoutError(f"Serial did not contain {expected!r}")
            target += 2
            await asyncio.wait_for(
                client.wait_until_simulation_time(target),
                timeout=20,
            )
            await asyncio.sleep(0.05)
        print("[SCENARIO] Serial condition matched.", flush=True)
        return target

    if "delay" in step:
        delay_seconds = parse_duration(step["delay"])
        target = max(
            current_simulation_seconds + delay_seconds,
            client.last_pause_nanos / 1_000_000_000 + delay_seconds,
        )
        print(f"\n[SCENARIO] Hold sensor state for {delay_seconds:g}s", flush=True)
        await asyncio.wait_for(
            client.wait_until_simulation_time(target),
            timeout=max(30, delay_seconds * 5),
        )
        return target

    raise ValueError(f"Unsupported scenario step: {step}")


async def main() -> None:
    args = parse_args()
    token = os.environ.get("WOKWI_CLI_TOKEN", "").strip()
    if not token:
        raise RuntimeError("WOKWI_CLI_TOKEN is missing")

    scenario = yaml.safe_load(args.scenario.read_text(encoding="utf-8"))
    steps = scenario.get("steps")
    if not isinstance(steps, list) or not steps:
        raise ValueError("Scenario must contain a non-empty steps list")

    firmware_path = Path(".pio/build/esp32dev/firmware.bin")
    bootloader_path = Path(".pio/build/esp32dev/bootloader.bin")
    partitions_path = Path(".pio/build/esp32dev/partitions.bin")
    diagram_path = Path("diagram.json")
    if not firmware_path.is_file():
        raise FileNotFoundError(f"Missing firmware: {firmware_path}")
    if not diagram_path.is_file():
        raise FileNotFoundError(f"Missing diagram: {diagram_path}")
    if not bootloader_path.is_file():
        raise FileNotFoundError(f"Missing bootloader: {bootloader_path}")
    if not partitions_path.is_file():
        raise FileNotFoundError(f"Missing partition table: {partitions_path}")

    client = WokwiClient(token)
    serial = SerialCapture(args.serial_log_file)
    connected = False
    try:
        print("[WOKWI SDK] Connecting to Simulation API...", flush=True)
        await asyncio.wait_for(client.connect(), timeout=CONNECT_TIMEOUT_SECONDS)
        connected = True
        print("[WOKWI SDK] Uploading ESP32 flash sections...", flush=True)
        await asyncio.wait_for(
            client.upload_file("diagram.json", diagram_path),
            timeout=UPLOAD_TIMEOUT_SECONDS,
        )
        await asyncio.wait_for(
            client.upload_file("firmware.bin", firmware_path),
            timeout=UPLOAD_TIMEOUT_SECONDS,
        )
        await asyncio.wait_for(
            client.upload_file("bootloader.bin", bootloader_path),
            timeout=UPLOAD_TIMEOUT_SECONDS,
        )
        await asyncio.wait_for(
            client.upload_file("partitions.bin", partitions_path),
            timeout=UPLOAD_TIMEOUT_SECONDS,
        )
        flash_sections = [
            FlashSection(offset=0x1000, file="bootloader.bin"),
            FlashSection(offset=0x8000, file="partitions.bin"),
            FlashSection(offset=0x10000, file="firmware.bin"),
        ]
        print("[WOKWI SDK] Starting paused simulation...", flush=True)
        await asyncio.wait_for(
            client.start_simulation(
                firmware=flash_sections,
                flash_size=4,
                pause=True,
            ),
            timeout=START_TIMEOUT_SECONDS,
        )
        client.serial_monitor(serial.feed)
        # Give the monitor task one event-loop turn to subscribe before boot.
        await asyncio.sleep(0.2)
        print(f"[WOKWI SDK] Running: {scenario.get('name', args.scenario.stem)}", flush=True)

        simulation_seconds = 0.0
        for index, step in enumerate(steps, start=1):
            if not isinstance(step, dict):
                raise ValueError(f"Step {index} must be an object")
            simulation_seconds = await run_step(
                client,
                serial,
                step,
                simulation_seconds,
            )

        print("\n[WOKWI SDK] Scenario completed successfully.", flush=True)
    finally:
        serial.close()
        if connected:
            try:
                await asyncio.wait_for(client.disconnect(), timeout=10)
            except BaseException as error:  # pragma: no cover - best-effort cleanup
                print(
                    f"[WOKWI SDK] Disconnect warning: {type(error).__name__}",
                    file=sys.stderr,
                )


if __name__ == "__main__":
    asyncio.run(main())
