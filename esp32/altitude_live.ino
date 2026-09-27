/*
  ALTITUDE live telemetry firmware for ESP32-S3.
  Adjust pins and calibration constants to your actual wiring before flashing.

  Libraries:
  - Adafruit BME280 Library
  - Adafruit INA260 Library
  - OneWire
  - DallasTemperature
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <Adafruit_BME280.h>
#include <Adafruit_INA260.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <math.h>

// ---------- CHANGE THESE ----------
const char* WIFI_SSID = "YOUR_WIFI";
const char* WIFI_PASS = "YOUR_PASSWORD";
const char* SERVER_BASE = "http://192.168.1.8:8080"; // laptop IP on same Wi-Fi
const char* DEVICE_ID = "altitude-01";

// GPIO numbers are examples only; change to your actual PCB/wiring.
const int PIN_DS18B20 = 4;
const int PIN_NTC = 1;
const int PIN_WATER = 2;
const int PIN_ESTOP = 14;      // use an isolated/status contact; E-stop should be hardwired too
const int PIN_PUMP = 12;
const int PIN_PELTIER = 13;
const int PIN_FAN = 11;

// Water sensor calibration: record raw ADC values at empty and full.
const int WATER_RAW_EMPTY = 650;
const int WATER_RAW_FULL = 2800;

// NTC 100k / B3950 with 100k series resistor.
const float NTC_R0 = 100000.0;
const float NTC_BETA = 3950.0;
const float NTC_T0_K = 25.0 + 273.15;
const float NTC_SERIES_R = 100000.0;
const float ADC_MAX = 4095.0;
// ----------------------------------

Adafruit_BME280 bme;
Adafruit_INA260 ina260;
OneWire oneWire(PIN_DS18B20);
DallasTemperature ds18b20(&oneWire);

bool bmeOK = false;
bool inaOK = false;
unsigned long lastSend = 0;
unsigned long lastCommandPoll = 0;

float readNTCC() {
  int raw = analogRead(PIN_NTC);
  if (raw <= 0 || raw >= 4095) return NAN;
  float rNtc = NTC_SERIES_R * ((float)raw / (ADC_MAX - (float)raw));
  float invT = (1.0 / NTC_T0_K) + (1.0 / NTC_BETA) * log(rNtc / NTC_R0);
  return (1.0 / invT) - 273.15;
}

float readWaterPct() {
  int raw = analogRead(PIN_WATER);
  float pct = 100.0 * (raw - WATER_RAW_EMPTY) / (float)(WATER_RAW_FULL - WATER_RAW_EMPTY);
  return constrain(pct, 0.0, 100.0);
}

void ensureWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("Wi-Fi");
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(350); Serial.print('.');
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("ESP32 IP: "); Serial.println(WiFi.localIP());
  }
}

String boolJson(bool v) { return v ? "true" : "false"; }
String floatJson(float v, int digits = 2) { return isnan(v) ? "null" : String(v, digits); }

void sendTelemetry() {
  if (WiFi.status() != WL_CONNECTED) return;

  ds18b20.requestTemperatures();
  float electronicsC = ds18b20.getTempCByIndex(0);
  if (electronicsC <= -126.0) electronicsC = NAN;

  float ambientC = bmeOK ? bme.readTemperature() : NAN;
  float humidity = bmeOK ? bme.readHumidity() : NAN;
  float pressureHpa = bmeOK ? bme.readPressure() / 100.0F : NAN;
  float coolantC = readNTCC();
  float waterPct = readWaterPct();

  float voltageV = inaOK ? ina260.readBusVoltage() / 1000.0F : NAN;
  float currentA = inaOK ? ina260.readCurrent() / 1000.0F : NAN;
  float powerW = inaOK ? ina260.readPower() / 1000.0F : NAN;

  // This input should be wired so HIGH/LOW matches your isolated E-stop status contact.
  bool eStop = digitalRead(PIN_ESTOP) == LOW;

  // Report what the ESP32 output pins are currently requesting.
  bool pump = digitalRead(PIN_PUMP) == HIGH;
  bool peltier = digitalRead(PIN_PELTIER) == HIGH;
  bool fan = digitalRead(PIN_FAN) == HIGH;

  String body = "{";
  body += "\"deviceId\":\"" + String(DEVICE_ID) + "\",";
  body += "\"sensors\":{";
  body += "\"ambientTempC\":" + floatJson(ambientC) + ",";
  body += "\"electronicsTempC\":" + floatJson(electronicsC) + ",";
  body += "\"coolantTempC\":" + floatJson(coolantC) + ",";
  body += "\"humidityPct\":" + floatJson(humidity) + ",";
  body += "\"pressureHpa\":" + floatJson(pressureHpa) + ",";
  body += "\"voltageV\":" + floatJson(voltageV, 3) + ",";
  body += "\"currentA\":" + floatJson(currentA, 3) + ",";
  body += "\"powerW\":" + floatJson(powerW, 3) + ",";
  body += "\"waterLevelPct\":" + floatJson(waterPct, 1);
  body += "},";
  body += "\"safety\":{\"eStop\":" + boolJson(eStop) + "},";
  body += "\"actuators\":{";
  body += "\"pump\":" + boolJson(pump) + ",";
  body += "\"peltier\":" + boolJson(peltier) + ",";
  body += "\"fan\":" + boolJson(fan);
  body += "}}";

  HTTPClient http;
  http.begin(String(SERVER_BASE) + "/api/telemetry");
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(body);
  Serial.printf("POST telemetry -> %d\n", code);
  if (code > 0) Serial.println(http.getString());
  http.end();
}

bool extractBool(const String& json, const char* key, bool* found) {
  String token = "\"" + String(key) + "\":";
  int p = json.indexOf(token);
  if (p < 0) { *found = false; return false; }
  p += token.length();
  while (p < json.length() && json[p] == ' ') p++;
  if (json.startsWith("true", p)) { *found = true; return true; }
  if (json.startsWith("false", p)) { *found = true; return false; }
  *found = false; // null means leave unchanged
  return false;
}

void pollCommands() {
  if (WiFi.status() != WL_CONNECTED) return;
  HTTPClient http;
  String url = String(SERVER_BASE) + "/api/device/command?deviceId=" + DEVICE_ID;
  http.begin(url);
  int code = http.GET();
  if (code == 200) {
    String json = http.getString();
    bool foundPump, foundPeltier, foundFan;
    bool reqPump = extractBool(json, "pump", &foundPump);
    bool reqPeltier = extractBool(json, "peltier", &foundPeltier);
    bool reqFan = extractBool(json, "fan", &foundFan);

    bool eStop = digitalRead(PIN_ESTOP) == LOW;
    float waterPct = readWaterPct();
    bool coolingAllowed = !eStop && waterPct > 20.0;

    if (!coolingAllowed) {
      digitalWrite(PIN_PUMP, LOW);
      digitalWrite(PIN_PELTIER, LOW);
      digitalWrite(PIN_FAN, LOW);
    } else {
      if (foundPump) digitalWrite(PIN_PUMP, reqPump ? HIGH : LOW);
      if (foundPeltier) digitalWrite(PIN_PELTIER, reqPeltier ? HIGH : LOW);
      if (foundFan) digitalWrite(PIN_FAN, reqFan ? HIGH : LOW);
    }
  }
  http.end();
}

void setup() {
  Serial.begin(115200);
  delay(300);
  pinMode(PIN_ESTOP, INPUT_PULLUP);
  pinMode(PIN_PUMP, OUTPUT);
  pinMode(PIN_PELTIER, OUTPUT);
  pinMode(PIN_FAN, OUTPUT);
  digitalWrite(PIN_PUMP, LOW);
  digitalWrite(PIN_PELTIER, LOW);
  digitalWrite(PIN_FAN, LOW);

  analogReadResolution(12);
  Wire.begin();
  ds18b20.begin();
  bmeOK = bme.begin(0x76) || bme.begin(0x77);
  inaOK = ina260.begin();

  Serial.printf("BME280: %s | INA260: %s\n", bmeOK ? "OK" : "NOT FOUND", inaOK ? "OK" : "NOT FOUND");
  ensureWiFi();
}

void loop() {
  ensureWiFi();
  const unsigned long now = millis();

  if (now - lastCommandPoll >= 700) {
    lastCommandPoll = now;
    pollCommands();
  }
  if (now - lastSend >= 1000) {
    lastSend = now;
    sendTelemetry();
  }
  delay(10);
}
