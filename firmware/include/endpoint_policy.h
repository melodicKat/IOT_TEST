#pragma once

#include <Arduino.h>

namespace EndpointPolicy {

constexpr char WIFI_SSID[] = "Wokwi-GUEST";
constexpr char WIFI_PASSWORD[] = "";
constexpr uint8_t WIFI_CHANNEL = 6;
constexpr uint16_t MQTT_TLS_PORT = 8883;

// Application/service allowlist:
// 1) *.hivemq.cloud (this firmware)
// 2) api.openweathermap.org (MagicMirror config)
// 3) calendar.google.com (MagicMirror config)
inline bool isAllowedHiveMqHost(const String &host) {
  return host == "hivemq.cloud" || host.endsWith(".hivemq.cloud");
}

}  // namespace EndpointPolicy
