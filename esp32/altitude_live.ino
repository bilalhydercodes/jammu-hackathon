/*
  =============================================================================
   SMART TEMPERATURE & PUMP PROTECTION SYSTEM (ESP32-S3)
  =============================================================================
   Hardware Pinout:
   - 3x Dallas DS18B20 digital temperature sensors on 1-Wire bus (GPIO 4)
   - 1x 10k NTC thermistor on analog ADC (GPIO 1) with Steinhart-Hart calculation
   - 1x Analog water level sensor (GPIO 5)
   - IRF520 MOSFET Water Pump control (GPIO 12)
   - Audible alarm buzzer (GPIO 17)
   - Status RGB LEDs: Red Alert (GPIO 38), Green Safe (GPIO 39), Blue Wi-Fi (GPIO 40)
   - Autonomous safety trigger: If Highest Temp > 35.0 °C -> Pump ON, Buzzer ON, Red LED ON
   - Real-time Wi-Fi telemetry streaming to local Node.js Gateway & Next.js dashboard
  =============================================================================
*/

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <math.h>

// ==================== WI-FI & SERVER CONFIGURATION ====================
// Windows Mobile Hotspot (2.4 GHz):
const char* WIFI_SSID = "jammubhai";
const char* WIFI_PASS = "987654321";

// Render Cloud Backend:
const char* SERVER_BASE = "https://jammu-hackathon.onrender.com";

const char* DEVICE_ID = "altitude-01";
const char* DEVICE_MODEL = "ESP32-S3";
const char* FIRMWARE_VERSION = "2.3.0-s3";

// ==================== HARDWARE PIN CONFIGURATION ====================
#define ONE_WIRE_BUS 4      // 3x DS18B20 Data pin
#define NTC_PIN      1      // NTC Analog Pin (GPIO 1)
#define WATER_PIN    5      // Water Level Analog Pin (GPIO 5)

#define PUMP_PIN     12     // IRF520 SIG (Water Pump)
#define BUZZER_PIN   17     // Buzzer (through transistor)

#define RED_LED      38     // Red Status LED (Alarm / OverTemp)
#define GREEN_LED    39     // Green Status LED (Normal / Safe)
#define BLUE_LED     40     // Blue Status LED (Wi-Fi Link / Telemetry)

// ==================== SENSOR & SAFETY SETTINGS ====================
#define TEMP_LIMIT      35.0    // Temperature Limit (Celsius)
#define SERIES_RESISTOR 10000.0 // NTC 10k Series Resistor
#define NTC_NOMINAL     10000.0 // 10k NTC nominal at 25°C
#define TEMP_NOMINAL    25.0    // Nominal temperature in Celsius
#define B_COEFFICIENT   3950.0  // Beta coefficient

// Water sensor calibration (0 - 4095)
#define WATER_ADC_EMPTY 600
#define WATER_ADC_FULL  2800

// ==================== OBJECTS & GLOBAL VARIABLES ====================
OneWire oneWire(ONE_WIRE_BUS);
DallasTemperature sensors(&oneWire);

WiFiClient clientHttp;
WiFiClientSecure clientHttps;

float highestTemp = -127.0;
float dsTemp[3]   = {-127.0, -127.0, -127.0};
float ntcTemp     = -999.0;
int   ntcRawAdc   = 0;
int   waterRaw    = 0;
float waterPct    = 0.0;
bool  overTemp    = false;

bool isRegistered = false;
int consecutiveFailures = 0;
const int MAX_FAILURES = 3;

unsigned long lastTelemetryMs = 0;
unsigned long lastHeartbeatMs = 0;
unsigned long lastWiFiRetryMs = 0;
const unsigned long TELEMETRY_INTERVAL_MS = 1500; // Send telemetry every 1.5s
const unsigned long HEARTBEAT_INTERVAL_MS = 5000; // Heartbeat every 5s

// ----------------------------------------------------
// Helper: Initialize HTTPClient for HTTP or HTTPS
// ----------------------------------------------------
void initHttp(HTTPClient &http, String url) {
  if (url.startsWith("https://")) {
    clientHttps.setInsecure(); // Accept HTTPS tunnel certificate
    http.begin(clientHttps, url);
  } else {
    http.begin(clientHttp, url);
  }
}

// ----------------------------------------------------
// NTC Steinhart-Hart Temperature Calculation (Auto-detects Pull-Up vs Pull-Down)
// ----------------------------------------------------
float readNTCTemp() {
  int adcValue = analogRead(NTC_PIN);
  ntcRawAdc = adcValue;
  if (adcValue <= 10 || adcValue >= 4085) return -999.0;

  // 1. Try Standard Pull-Up: 3.3V -> 10k Resistor -> GPIO 1 -> NTC -> GND
  float resistance = SERIES_RESISTOR * ((4095.0 / (float)adcValue) - 1.0);
  float steinhart = resistance / NTC_NOMINAL;
  steinhart = log(steinhart);
  steinhart /= B_COEFFICIENT;
  steinhart += 1.0 / (TEMP_NOMINAL + 273.15);
  steinhart = 1.0 / steinhart;
  steinhart -= 273.15;

  // 2. If result is negative (< -10C) while DS18B20 is positive (~18C),
  // the wiring is Pull-Down: 3.3V -> NTC -> GPIO 1 -> 10k Resistor -> GND
  if (steinhart < -10.0) {
    float altResistance = SERIES_RESISTOR / ((4095.0 / (float)adcValue) - 1.0);
    float altSteinhart = altResistance / NTC_NOMINAL;
    altSteinhart = log(altSteinhart);
    altSteinhart /= B_COEFFICIENT;
    altSteinhart += 1.0 / (TEMP_NOMINAL + 273.15);
    altSteinhart = 1.0 / altSteinhart;
    altSteinhart -= 273.15;
    if (altSteinhart > -10.0 && altSteinhart < 120.0) {
      return altSteinhart;
    }
  }

  return steinhart;
}

// ----------------------------------------------------
// Water Level Percentage Calculation
// ----------------------------------------------------
float readWaterLevelPct(int rawAdc) {
  if (rawAdc <= 50) return 0.0;
  float pct = ((float)(rawAdc - WATER_ADC_EMPTY) / (float)(WATER_ADC_FULL - WATER_ADC_EMPTY)) * 100.0;
  return constrain(pct, 0.0, 100.0);
}

// ----------------------------------------------------
// Wi-Fi 2.4 GHz Scan & Connection Manager
// ----------------------------------------------------
void scanAndConnectWiFi() {
  Serial.println("\n[Wi-Fi] Initializing 2.4 GHz Wi-Fi Radio...");
  WiFi.disconnect(true);
  delay(100);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false); // Disable modem power saving for maximum antenna signal

  Serial.println("[Wi-Fi] Scanning available 2.4 GHz networks...");
  int n = WiFi.scanNetworks();
  bool ssidFound = false;

  if (n == 0) {
    Serial.println("❌ No 2.4 GHz Wi-Fi networks found!");
  } else {
    Serial.printf("Found %d visible 2.4 GHz Wi-Fi network(s):\n", n);
    for (int i = 0; i < n; ++i) {
      String foundSSID = WiFi.SSID(i);
      int rssi = WiFi.RSSI(i);
      bool isMatch = (foundSSID == WIFI_SSID);
      Serial.printf("   [%d] %-20s (Signal: %d dBm)%s\n", i + 1, foundSSID.c_str(), rssi, isMatch ? "  <-- MATCH!" : "");
      if (isMatch) ssidFound = true;
    }
  }

  Serial.print("[Wi-Fi] Attempting connection to: ");
  Serial.println(WIFI_SSID);

  WiFi.begin(WIFI_SSID, WIFI_PASS);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - start < 15000)) {
    digitalWrite(BLUE_LED, !digitalRead(BLUE_LED));
    delay(250);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    digitalWrite(BLUE_LED, HIGH);
    Serial.println("\n[Wi-Fi] Connected successfully!");
    Serial.print("[Wi-Fi] IP Address: ");
    Serial.println(WiFi.localIP());
    Serial.print("[Wi-Fi] RSSI Signal: ");
    Serial.print(WiFi.RSSI());
    Serial.println(" dBm");
  } else {
    digitalWrite(BLUE_LED, LOW);
    Serial.println("\n[Wi-Fi] Connection timeout. Operating in autonomous local mode.");
  }
}

// ----------------------------------------------------
// Register Device with Backend
// ----------------------------------------------------
bool registerWithBackend() {
  if (WiFi.status() != WL_CONNECTED) return false;

  HTTPClient http;
  String url = String(SERVER_BASE) + "/api/device/register";
  initHttp(http, url);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(4000);

  String payload = "{";
  payload += "\"deviceId\":\"" + String(DEVICE_ID) + "\",";
  payload += "\"model\":\"" + String(DEVICE_MODEL) + "\",";
  payload += "\"firmware\":\"" + String(FIRMWARE_VERSION) + "\",";
  payload += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
  payload += "\"mac\":\"" + WiFi.macAddress() + "\",";
  payload += "\"status\":\"CONNECTED\",";
  payload += "\"sensors\":{";
  payload += "\"ds18b20Count\":" + String(sensors.getDeviceCount()) + ",";
  payload += "\"ntc\":true,";
  payload += "\"water\":true";
  payload += "},";
  payload += "\"hasError\":false";
  payload += "}";

  int code = http.POST(payload);
  Serial.printf("[Backend] Registration -> HTTP %d\n", code);

  if (code == 200 || code == 201 || code == 202) {
    isRegistered = true;
    consecutiveFailures = 0;
    http.end();
    return true;
  }
  isRegistered = false;
  http.end();
  return false;
}

// ----------------------------------------------------
// Send Periodic Heartbeat
// ----------------------------------------------------
void sendHeartbeat() {
  if (WiFi.status() != WL_CONNECTED || !isRegistered) return;

  HTTPClient http;
  String url = String(SERVER_BASE) + "/api/device/heartbeat";
  initHttp(http, url);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(3000);

  String payload = "{";
  payload += "\"deviceId\":\"" + String(DEVICE_ID) + "\",";
  payload += "\"model\":\"" + String(DEVICE_MODEL) + "\",";
  payload += "\"status\":\"CONNECTED\",";
  payload += "\"uptimeMs\":" + String(millis()) + ",";
  payload += "\"wifiRssi\":" + String(WiFi.RSSI()) + ",";
  payload += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
  payload += "\"hasError\":false";
  payload += "}";

  int code = http.POST(payload);
  if (code == 200 || code == 202) {
    consecutiveFailures = 0;
  } else {
    consecutiveFailures++;
    if (consecutiveFailures >= MAX_FAILURES) isRegistered = false;
  }
  http.end();
}

// ----------------------------------------------------
// Stream Live Telemetry to Backend
// ----------------------------------------------------
void sendTelemetry() {
  if (WiFi.status() != WL_CONNECTED) {
    if (millis() - lastWiFiRetryMs > 10000) {
      lastWiFiRetryMs = millis();
      WiFi.begin(WIFI_SSID, WIFI_PASS);
    }
    return;
  }

  if (!isRegistered) {
    if (!registerWithBackend()) return;
  }

  HTTPClient http;
  String url = String(SERVER_BASE) + "/api/telemetry";
  initHttp(http, url);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(3500);

  bool pumpState   = (digitalRead(PUMP_PIN) == HIGH);
  bool buzzerState = (digitalRead(BUZZER_PIN) == HIGH);
  bool redState    = (digitalRead(RED_LED) == HIGH);
  bool greenState  = (digitalRead(GREEN_LED) == HIGH);
  bool blueState   = (digitalRead(BLUE_LED) == HIGH);

  String payload = "{";
  payload += "\"deviceId\":\"" + String(DEVICE_ID) + "\",";
  payload += "\"model\":\"" + String(DEVICE_MODEL) + "\",";
  payload += "\"deviceStatus\":\"CONNECTED\",";
  payload += "\"sensors\":{";
  payload += "\"highestTempC\":" + (highestTemp > -100.0 ? String(highestTemp, 2) : "null") + ",";
  payload += "\"dsTemp1C\":" + (dsTemp[0] > -100.0 ? String(dsTemp[0], 2) : "null") + ",";
  payload += "\"dsTemp2C\":" + (dsTemp[1] > -100.0 ? String(dsTemp[1], 2) : "null") + ",";
  payload += "\"dsTemp3C\":" + (dsTemp[2] > -100.0 ? String(dsTemp[2], 2) : "null") + ",";
  payload += "\"ntcTempC\":" + (ntcTemp > -900.0 ? String(ntcTemp, 2) : "null") + ",";
  payload += "\"waterAdc\":" + String(waterRaw) + ",";
  payload += "\"waterLevelPct\":" + String(waterPct, 1) + ",";
  payload += "\"tempLimitC\":" + String(TEMP_LIMIT, 1) + ",";
  payload += "\"overTemp\":" + String(overTemp ? "true" : "false");
  payload += "},";
  payload += "\"safety\":{";
  payload += "\"overTemp\":" + String(overTemp ? "true" : "false");
  payload += "},";
  payload += "\"actuators\":{";
  payload += "\"pump\":" + String(pumpState ? "true" : "false") + ",";
  payload += "\"buzzer\":" + String(buzzerState ? "true" : "false") + ",";
  payload += "\"redLed\":" + String(redState ? "true" : "false") + ",";
  payload += "\"greenLed\":" + String(greenState ? "true" : "false") + ",";
  payload += "\"blueLed\":" + String(blueState ? "true" : "false");
  payload += "}}";

  int code = http.POST(payload);
  if (code == 200 || code == 202) {
    consecutiveFailures = 0;
  } else {
    consecutiveFailures++;
    if (consecutiveFailures >= MAX_FAILURES) isRegistered = false;
  }
  http.end();
}

// ==================== SETUP ====================
void setup() {
  Serial.begin(115200);

  // Allow time for Serial Monitor to initialize
  unsigned long start = millis();
  while (!Serial && (millis() - start < 3000)) {
    delay(10);
  }

  Serial.println("\n=================================");
  Serial.println("   SMART TEMP & PUMP SYSTEM");
  Serial.println("=================================");

  // Pin Modes
  pinMode(PUMP_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(RED_LED, OUTPUT);
  pinMode(GREEN_LED, OUTPUT);
  pinMode(BLUE_LED, OUTPUT);

  pinMode(NTC_PIN, INPUT);
  pinMode(WATER_PIN, INPUT);

  // Safe Initial State
  digitalWrite(PUMP_PIN, LOW);
  digitalWrite(BUZZER_PIN, LOW);
  digitalWrite(RED_LED, LOW);
  digitalWrite(GREEN_LED, HIGH); // Green on for safe standby
  digitalWrite(BLUE_LED, LOW);

  // DS18B20 1-Wire Init
  pinMode(ONE_WIRE_BUS, INPUT_PULLUP);
  sensors.begin();

  int count = sensors.getDeviceCount();
  Serial.print("DS18B20 Sensors Detected: ");
  Serial.println(count);
  if (count == 0) {
    Serial.println("❌ Warning: No DS18B20 found. Check 4.7k pull-up resistor & wiring.");
  }

  // Scan 2.4 GHz networks & connect to Laptop Hotspot
  scanAndConnectWiFi();

  // Initial Backend Registration
  if (WiFi.status() == WL_CONNECTED) {
    registerWithBackend();
  }

  Serial.println("=================================\n");
}

// ==================== MAIN LOOP ====================
void loop() {
  unsigned long currentMs = millis();

  // 1. Read DS18B20 1-Wire Temperatures
  sensors.requestTemperatures();
  int count = sensors.getDeviceCount();

  highestTemp = -127.0;
  overTemp = false;

  Serial.println("---- LIVE SYSTEM DATA ----");

  for (int i = 0; i < 3; i++) {
    Serial.print("DS Sensor ");
    Serial.print(i + 1);
    Serial.print(": ");

    if (i < count) {
      float t = sensors.getTempCByIndex(i);
      dsTemp[i] = t;
      if (t == DEVICE_DISCONNECTED_C || t <= -126.0) {
        Serial.println("DISCONNECTED ❌");
      } else {
        Serial.print(t, 2);
        Serial.println(" C");
        if (t > highestTemp) highestTemp = t;
        if (t > TEMP_LIMIT) overTemp = true;
      }
    } else {
      dsTemp[i] = -127.0;
      Serial.println("NOT DETECTED");
    }
  }

  // 2. Read NTC Thermistor
  ntcTemp = readNTCTemp();
  Serial.print("NTC Temp  : ");
  if (ntcTemp == -999.0) {
    Serial.println("ERROR (Disconnected)");
  } else {
    Serial.print(ntcTemp, 2);
    Serial.print(" C  (ADC: ");
    Serial.print(ntcRawAdc);
    Serial.println(")");
    if (ntcTemp > highestTemp) highestTemp = ntcTemp;
    if (ntcTemp > TEMP_LIMIT) overTemp = true;
  }

  // 3. Read Water Level
  waterRaw = analogRead(WATER_PIN);
  waterPct = readWaterLevelPct(waterRaw);
  Serial.print("Water Level: ADC ");
  Serial.print(waterRaw);
  Serial.print(" (");
  Serial.print(waterPct, 1);
  Serial.println(" %)");

  // 4. Autonomous Safety & Actuator Logic
  Serial.println("--------------------------");
  if (overTemp) {
    digitalWrite(PUMP_PIN, HIGH);    // Water Pump ON
    digitalWrite(BUZZER_PIN, HIGH);  // Buzzer ON
    digitalWrite(RED_LED, HIGH);     // Red LED ON
    digitalWrite(GREEN_LED, LOW);    // Green LED OFF

    Serial.print("🔥 ALERT! Temp > ");
    Serial.print(TEMP_LIMIT, 1);
    Serial.println(" C");
    Serial.println("👉 PUMP: ON | BUZZER: ON | LED: RED");
  } else {
    digitalWrite(PUMP_PIN, LOW);     // Water Pump OFF
    digitalWrite(BUZZER_PIN, LOW);   // Buzzer OFF
    digitalWrite(RED_LED, LOW);      // Red LED OFF
    digitalWrite(GREEN_LED, HIGH);   // Green LED ON

    Serial.println("✅ Temp Normal");
    Serial.println("👉 PUMP: OFF | BUZZER: OFF | LED: GREEN");
  }

  Serial.print("Highest Temp: ");
  if (highestTemp <= -100.0) {
    Serial.println("N/A");
  } else {
    Serial.print(highestTemp, 2);
    Serial.println(" C");
  }

  // 5. Wi-Fi Status LED Indicator
  if (WiFi.status() == WL_CONNECTED) {
    digitalWrite(BLUE_LED, HIGH);
    Serial.print("Wi-Fi Status: CONNECTED (IP: ");
    Serial.print(WiFi.localIP());
    Serial.println(")");
  } else {
    digitalWrite(BLUE_LED, LOW);
    Serial.println("Wi-Fi Status: DISCONNECTED");
  }

  Serial.println("=================================\n");

  // 6. Network Telemetry & Heartbeat Streaming
  if (currentMs - lastTelemetryMs >= TELEMETRY_INTERVAL_MS) {
    lastTelemetryMs = currentMs;
    sendTelemetry();
  }

  if (currentMs - lastHeartbeatMs >= HEARTBEAT_INTERVAL_MS) {
    lastHeartbeatMs = currentMs;
    sendHeartbeat();
  }

  delay(1500); // 1.5 second loop delay
}
