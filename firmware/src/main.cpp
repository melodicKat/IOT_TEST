#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Arduino.h>
#include <DHTesp.h>
#include <PubSubClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <Wire.h>

#include "endpoint_policy.h"
#include "generated_secrets.h"

namespace {

constexpr uint8_t DHT_PIN = 15;
constexpr uint8_t BUTTON_PIN = 4;
constexpr uint8_t TOUCH_PIN = 13;
constexpr uint8_t PIR_PIN = 27;
constexpr uint8_t LDR_PIN = 34;
constexpr uint8_t CONNECTION_LED_PIN = 18;
constexpr uint8_t OLED_SDA_PIN = 21;
constexpr uint8_t OLED_SCL_PIN = 22;
constexpr uint8_t OLED_ADDRESS = 0x3C;
constexpr uint16_t OLED_WIDTH = 128;
constexpr uint16_t OLED_HEIGHT = 64;
constexpr unsigned long DHT_INTERVAL_MS = 2000;
constexpr unsigned long LDR_INTERVAL_MS = 500;
constexpr unsigned long LDR_HEARTBEAT_MS = 2000;
constexpr unsigned long RECONNECT_INTERVAL_MS = 5000;
constexpr unsigned long DISPLAY_INTERVAL_MS = 500;
constexpr unsigned long DEBOUNCE_MS = 40;
constexpr unsigned long AIRPLANE_HOLD_MS = 4000;
constexpr unsigned long TOUCH_LONG_PRESS_MS = 1200;
constexpr unsigned long TOUCH_DOUBLE_TAP_MS = 450;
constexpr float LDR_GAMMA = 0.7F;
constexpr float LDR_RL10_KOHM = 50.0F;
constexpr float LDR_VCC = 3.3F;
constexpr float DARK_LUX_THRESHOLD = 80.0F;
constexpr float LDR_CHANGE_MIN_LUX = 2.0F;

extern const uint8_t isrgRootX1Start[]
    asm("_binary_certs_isrgrootx1_pem_start");

DHTesp dht;
Adafruit_SSD1306 display(OLED_WIDTH, OLED_HEIGHT, &Wire, -1);
WiFiClientSecure tlsClient;
PubSubClient mqtt(tlsClient);

enum class ViewMode : uint8_t {
  Normal,
  Calendar,
  Mirror,
  Settings,
};

String temperatureTopic;
String humidityTopic;
String presenceTopic;
String ambientLightTopic;
String buttonTopic;
String statusTopic;

float temperatureC = NAN;
float humidityPct = NAN;
float ambientLux = NAN;
int ambientAdcRaw = 0;
bool presenceDetected = false;
bool presencePublished = false;
bool oledReady = false;
uint8_t oledContrast = 0xCF;
ViewMode viewMode = ViewMode::Normal;
bool airplaneMode = false;
bool longPressHandled = false;
bool rawButtonPressed = false;
bool stableButtonPressed = false;
bool rawTouchPressed = false;
bool stableTouchPressed = false;
bool touchLongPressHandled = false;
bool touchTapPending = false;
uint32_t interactionSequence = 0;
unsigned long buttonChangedAt = 0;
unsigned long buttonPressedAt = 0;
unsigned long touchChangedAt = 0;
unsigned long touchPressedAt = 0;
unsigned long touchReleasedAt = 0;
unsigned long lastDhtAt = 0;
unsigned long lastLdrAt = 0;
unsigned long lastLdrPublishedAt = 0;
unsigned long lastReconnectAt = 0;
unsigned long lastDisplayAt = 0;
float publishedAmbientLux = NAN;

constexpr char ONLINE_PAYLOAD[] =
    "{\"online\":true,\"led\":\"ON\",\"reason\":\"connected\"}";
constexpr char OFFLINE_WILL_PAYLOAD[] =
    "{\"online\":false,\"led\":\"OFF\",\"reason\":\"lwt\"}";
constexpr char OFFLINE_MANUAL_PAYLOAD[] =
    "{\"online\":false,\"led\":\"OFF\",\"reason\":\"airplane\"}";

const char *viewModeName(ViewMode mode) {
  switch (mode) {
    case ViewMode::Calendar:
      return "calendar";
    case ViewMode::Mirror:
      return "mirror";
    case ViewMode::Settings:
      return "settings";
    default:
      return "normal";
  }
}

const char *viewModeOledLabel(ViewMode mode) {
  switch (mode) {
    case ViewMode::Calendar:
      return "CALENDAR";
    case ViewMode::Mirror:
      return "MIRROR";
    case ViewMode::Settings:
      return "SETTINGS";
    default:
      return "NORMAL";
  }
}

void advanceViewMode() {
  switch (viewMode) {
    case ViewMode::Normal:
      viewMode = ViewMode::Calendar;
      break;
    case ViewMode::Calendar:
      viewMode = ViewMode::Mirror;
      break;
    default:
      viewMode = ViewMode::Normal;
      break;
  }
}

void publishInteraction(const char *event, const char *source,
                        const char *gesture) {
  interactionSequence++;
  if (!mqtt.connected()) return;

  char payload[192];
  snprintf(
      payload, sizeof(payload),
      "{\"event\":\"%s\",\"source\":\"%s\",\"gesture\":\"%s\","
      "\"sequence\":%lu,\"view\":\"%s\",\"uptimeMs\":%lu}",
      event, source, gesture, static_cast<unsigned long>(interactionSequence),
      viewModeName(viewMode), millis());
  mqtt.publish(buttonTopic.c_str(), payload, false);
  Serial.printf("[INPUT] source=%s gesture=%s view=%s\n", source, gesture,
                viewModeName(viewMode));
}

void startWifi() {
  if (airplaneMode) return;
  Serial.println("[NET] Connecting to allowlisted AP Wokwi-GUEST (channel 6)");
  WiFi.mode(WIFI_STA);
  WiFi.begin(EndpointPolicy::WIFI_SSID, EndpointPolicy::WIFI_PASSWORD,
             EndpointPolicy::WIFI_CHANNEL);
  lastReconnectAt = millis();
}

void setAirplaneMode(bool enabled) {
  airplaneMode = enabled;
  if (enabled) {
    Serial.println("[TEST] Airplane mode ON: simulating WiFi outage");
    if (mqtt.connected()) {
      mqtt.publish(statusTopic.c_str(), OFFLINE_MANUAL_PAYLOAD, true);
      mqtt.loop();
      delay(30);
      mqtt.disconnect();
    }
    WiFi.disconnect(true);
    WiFi.mode(WIFI_OFF);
    digitalWrite(CONNECTION_LED_PIN, LOW);
  } else {
    Serial.println("[TEST] Airplane mode OFF: reconnecting WiFi");
    startWifi();
  }
}

void updateConnectionLed() {
  if (airplaneMode) {
    digitalWrite(CONNECTION_LED_PIN, LOW);
  } else if (mqtt.connected()) {
    digitalWrite(CONNECTION_LED_PIN, HIGH);
  } else {
    digitalWrite(CONNECTION_LED_PIN, (millis() / 300) % 2);
  }
}

float readAmbientLux() {
  ambientAdcRaw = analogRead(LDR_PIN);
  const float voltage = ambientAdcRaw / 4095.0F * LDR_VCC;
  if (voltage <= 0.001F) return 100000.0F;
  if (voltage >= LDR_VCC - 0.001F) return 0.1F;

  const float resistance =
      10000.0F * voltage / (LDR_VCC - voltage);
  const float lux =
      pow((LDR_RL10_KOHM * 1000.0F * pow(10.0F, LDR_GAMMA)) / resistance,
          1.0F / LDR_GAMMA);
  return isfinite(lux) ? constrain(lux, 0.1F, 100000.0F) : 0.1F;
}

void updateOledBrightness() {
  if (!oledReady || isnan(ambientLux)) return;
  const uint8_t requestedContrast =
      ambientLux < DARK_LUX_THRESHOLD ? 0x2F : 0xCF;
  if (requestedContrast == oledContrast) return;

  oledContrast = requestedContrast;
  display.ssd1306_command(SSD1306_SETCONTRAST);
  display.ssd1306_command(oledContrast);
  Serial.printf("[LDR] OLED contrast=%u (%s)\n", oledContrast,
                ambientLux < DARK_LUX_THRESHOLD ? "dim" : "normal");
}

void drawDisplay() {
  if (!oledReady) return;
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  display.setTextWrap(false);

  display.setCursor(0, 0);
  display.print("SMART MIRROR");
  display.drawLine(0, 9, OLED_WIDTH - 1, 9, SSD1306_WHITE);

  if (isnan(temperatureC) || isnan(humidityPct)) {
    display.setCursor(0, 14);
    display.print("T --.-C  H --.-%");
  } else {
    display.setCursor(0, 14);
    display.printf("T %4.1fC H %4.1f%%", temperatureC, humidityPct);
  }

  display.setCursor(0, 26);
  if (isnan(ambientLux)) {
    display.printf("PIR %-3s LUX ----", presenceDetected ? "YES" : "NO");
  } else {
    display.printf("PIR %-3s LUX %4.0f", presenceDetected ? "YES" : "NO",
                   ambientLux);
  }

  display.drawLine(0, 38, OLED_WIDTH - 1, 38, SSD1306_WHITE);
  display.setCursor(0, 41);
  display.printf("WIFI %-4s MQTT %s",
                 WiFi.status() == WL_CONNECTED ? "OK" : "DOWN",
                 mqtt.connected() ? "TLS" : "OFF");
  display.setCursor(0, 53);
  display.printf("OLED %-3s | %s",
                 ambientLux < DARK_LUX_THRESHOLD ? "DIM" : "MAX",
                 viewModeOledLabel(viewMode));
  display.display();
}

bool connectMqtt() {
  if (WiFi.status() != WL_CONNECTED || airplaneMode) return false;

  char clientId[40];
  const uint64_t chipId = ESP.getEfuseMac();
  snprintf(clientId, sizeof(clientId), "wokwi-esp32-%08lx",
           static_cast<unsigned long>(chipId & 0xFFFFFFFF));
  Serial.printf("[MQTT] TLS connect to %s:%u as %s\n", HIVEMQ_HOST,
                HIVEMQ_TCP_PORT, clientId);

  const bool connected = mqtt.connect(
      clientId, MQTT_USERNAME, MQTT_PASSWORD, statusTopic.c_str(), 1, true,
      OFFLINE_WILL_PAYLOAD, true);
  if (connected) {
    digitalWrite(CONNECTION_LED_PIN, HIGH);
    mqtt.publish(statusTopic.c_str(), ONLINE_PAYLOAD, true);
    presencePublished = false;
    publishedAmbientLux = NAN;
    lastDhtAt = millis() - DHT_INTERVAL_MS;
    lastLdrAt = millis() - LDR_INTERVAL_MS;
    Serial.println("[MQTT] Connected with TLS, auth and retained LWT");
  } else {
    Serial.printf("[MQTT] Connect failed, state=%d\n", mqtt.state());
  }
  return connected;
}

void maintainConnections() {
  if (airplaneMode) return;
  if (WiFi.status() != WL_CONNECTED) {
    if (millis() - lastReconnectAt >= RECONNECT_INTERVAL_MS) startWifi();
    return;
  }
  if (!mqtt.connected() && millis() - lastReconnectAt >= RECONNECT_INTERVAL_MS) {
    lastReconnectAt = millis();
    connectMqtt();
  }
  if (mqtt.connected()) mqtt.loop();
}

void readDhtAndPublish() {
  TempAndHumidity reading = dht.getTempAndHumidity();
  if (isnan(reading.temperature) || isnan(reading.humidity)) {
    Serial.println("[DHT22] Invalid sample; keeping last valid reading");
  } else {
    temperatureC = reading.temperature;
    humidityPct = reading.humidity;
    Serial.printf("[DHT22] %.1f C, %.1f %%\n", temperatureC, humidityPct);
  }

  if (!mqtt.connected() || isnan(temperatureC) || isnan(humidityPct)) return;
  char payload[16];
  snprintf(payload, sizeof(payload), "%.1f", temperatureC);
  mqtt.publish(temperatureTopic.c_str(), payload, true);
  snprintf(payload, sizeof(payload), "%.1f", humidityPct);
  mqtt.publish(humidityTopic.c_str(), payload, true);
}

void readLdrAndPublish() {
  ambientLux = readAmbientLux();
  updateOledBrightness();

  if (!mqtt.connected()) return;
  const unsigned long now = millis();
  const bool changed =
      isnan(publishedAmbientLux) ||
      fabs(ambientLux - publishedAmbientLux) >= LDR_CHANGE_MIN_LUX;
  const bool heartbeatDue =
      now - lastLdrPublishedAt >= LDR_HEARTBEAT_MS;
  if (!changed && !heartbeatDue) return;

  char payload[16];
  snprintf(payload, sizeof(payload), "%.0f", ambientLux);
  mqtt.publish(ambientLightTopic.c_str(), payload, true);
  publishedAmbientLux = ambientLux;
  lastLdrPublishedAt = now;
  Serial.printf("[LDR] raw=%d %.0f lux (%s)\n", ambientAdcRaw, ambientLux,
                ambientLux < DARK_LUX_THRESHOLD ? "dark" : "normal");
}

void handlePresenceSensor() {
  const bool detected = digitalRead(PIR_PIN) == HIGH;
  if (detected != presenceDetected) {
    presenceDetected = detected;
    presencePublished = false;
    Serial.printf("[PIR] Presence %s\n", presenceDetected ? "detected" : "clear");
  }
  if (!presencePublished && mqtt.connected()) {
    mqtt.publish(presenceTopic.c_str(), presenceDetected ? "1" : "0", true);
    presencePublished = true;
  }
}

void publishButtonEvent() {
  advanceViewMode();
  publishInteraction("pressed", "button", "tap");
}

void handleButton() {
  const bool pressed = digitalRead(BUTTON_PIN) == LOW;
  if (pressed != rawButtonPressed) {
    rawButtonPressed = pressed;
    buttonChangedAt = millis();
  }
  if (millis() - buttonChangedAt >= DEBOUNCE_MS &&
      stableButtonPressed != rawButtonPressed) {
    stableButtonPressed = rawButtonPressed;
    if (stableButtonPressed) {
      buttonPressedAt = millis();
      longPressHandled = false;
    } else if (!longPressHandled) {
      publishButtonEvent();
    }
  }
  if (stableButtonPressed && !longPressHandled &&
      millis() - buttonPressedAt >= AIRPLANE_HOLD_MS) {
    longPressHandled = true;
    setAirplaneMode(!airplaneMode);
  }
}

void publishSingleTouch() {
  if (viewMode == ViewMode::Mirror || viewMode == ViewMode::Settings) {
    viewMode = ViewMode::Normal;
  } else {
    advanceViewMode();
  }
  publishInteraction("touch", "touch", "tap");
}

void handleTouchSensor() {
  const unsigned long now = millis();
  const bool pressed = digitalRead(TOUCH_PIN) == LOW;
  if (pressed != rawTouchPressed) {
    rawTouchPressed = pressed;
    touchChangedAt = now;
  }

  if (now - touchChangedAt >= DEBOUNCE_MS &&
      stableTouchPressed != rawTouchPressed) {
    stableTouchPressed = rawTouchPressed;
    if (stableTouchPressed) {
      touchPressedAt = now;
      touchLongPressHandled = false;
    } else if (!touchLongPressHandled) {
      if (touchTapPending &&
          now - touchReleasedAt <= TOUCH_DOUBLE_TAP_MS) {
        touchTapPending = false;
        viewMode = ViewMode::Settings;
        publishInteraction("touch", "touch", "doubleTap");
      } else {
        if (touchTapPending) publishSingleTouch();
        touchTapPending = true;
        touchReleasedAt = now;
      }
    }
  }

  if (stableTouchPressed && !touchLongPressHandled &&
      now - touchPressedAt >= TOUCH_LONG_PRESS_MS) {
    touchLongPressHandled = true;
    touchTapPending = false;
    viewMode = ViewMode::Mirror;
    publishInteraction("touch", "touch", "longPress");
  }

  if (touchTapPending && !stableTouchPressed &&
      now - touchReleasedAt > TOUCH_DOUBLE_TAP_MS) {
    touchTapPending = false;
    publishSingleTouch();
  }
}

}  // namespace

void setup() {
  Serial.begin(115200);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(TOUCH_PIN, INPUT_PULLUP);
  pinMode(PIR_PIN, INPUT);
  pinMode(LDR_PIN, INPUT);
  pinMode(CONNECTION_LED_PIN, OUTPUT);
  digitalWrite(CONNECTION_LED_PIN, LOW);

  Wire.begin(OLED_SDA_PIN, OLED_SCL_PIN);
  oledReady = display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDRESS);
  dht.setup(DHT_PIN, DHTesp::DHT22);

  temperatureTopic = String(MQTT_TOPIC_PREFIX) + "/telemetry/temperature";
  humidityTopic = String(MQTT_TOPIC_PREFIX) + "/telemetry/humidity";
  presenceTopic = String(MQTT_TOPIC_PREFIX) + "/telemetry/presence";
  ambientLightTopic =
      String(MQTT_TOPIC_PREFIX) + "/telemetry/ambient-light";
  buttonTopic = String(MQTT_TOPIC_PREFIX) + "/event/button";
  statusTopic = String(MQTT_TOPIC_PREFIX) + "/status";

  if (!EndpointPolicy::isAllowedHiveMqHost(HIVEMQ_HOST) ||
      HIVEMQ_TCP_PORT != EndpointPolicy::MQTT_TLS_PORT) {
    Serial.println("[SECURITY] Blocked MQTT endpoint outside *.hivemq.cloud:8883");
    airplaneMode = true;
    drawDisplay();
    return;
  }

  tlsClient.setCACert(reinterpret_cast<const char *>(isrgRootX1Start));
  tlsClient.setHandshakeTimeout(15);
  mqtt.setServer(HIVEMQ_HOST, HIVEMQ_TCP_PORT);
  mqtt.setKeepAlive(15);
  mqtt.setSocketTimeout(10);
  mqtt.setBufferSize(512);

  lastDhtAt = millis() - DHT_INTERVAL_MS;
  lastLdrAt = millis() - LDR_INTERVAL_MS;
  lastReconnectAt = millis() - RECONNECT_INTERVAL_MS;
  startWifi();
  drawDisplay();
}

void loop() {
  handleButton();
  handleTouchSensor();
  maintainConnections();
  handlePresenceSensor();
  updateConnectionLed();

  if (millis() - lastDhtAt >= DHT_INTERVAL_MS) {
    lastDhtAt = millis();
    readDhtAndPublish();
  }
  if (millis() - lastLdrAt >= LDR_INTERVAL_MS) {
    lastLdrAt = millis();
    readLdrAndPublish();
  }
  if (millis() - lastDisplayAt >= DISPLAY_INTERVAL_MS) {
    lastDisplayAt = millis();
    drawDisplay();
  }
  delay(5);
}
