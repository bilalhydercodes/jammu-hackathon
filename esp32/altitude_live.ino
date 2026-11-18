/*
  =============================================================================
   SMART TEMPERATURE, PUMP & PELTIER PROTECTION SYSTEM (ESP32-S3)
  =============================================================================
   Hardware Pinout:
   - OLED 128x64 Display: I2C SDA (GPIO 8), SCL (GPIO 9), Addr 0x3C
   - 3x Dallas DS18B20 digital temperature sensors on 1-Wire bus (GPIO 4)
   - 1x 10k NTC thermistor on analog ADC (GPIO 1) with auto-calibrating Steinhart-Hart
   - 1x Analog water level sensor (GPIO 5)
   - IRF520 MOSFET Water Pump control (GPIO 12)
   - Relay IN Peltier / Cooling module (GPIO 13)
   - Audible alarm buzzer (GPIO 17)
   - Normal LED Indicator (GPIO 35) - Active on threshold
   - Status RGB LEDs: Red Alert (GPIO 38), Green Safe (GPIO 39), Blue Wi-Fi (GPIO 40)
   - Dual-Limit Hysteresis Safety:
       * Highest Temp >= 35.0 °C -> Cooling ON (Pump, Peltier, Buzzer, Red LED, Normal LED)
       * Highest Temp <= 30.0 °C -> Cooling OFF (Safe Standby, Green LED ON)
   - Real-time Wi-Fi telemetry streaming to Cloud Backend (Render / Vercel)
  =============================================================================
*/

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <math.h>

// ==================== WI-FI & CLOUD CONFIGURATION ====================
// Windows Mobile Hotspot (2.4 GHz):
const char* WIFI_SSID = "jammubhai";
const char* WIFI_PASS = "987654321";

// Cloud Host Endpoint (Render Cloud Backend / Vercel Domain):
const char* SERVER_BASE = "https://jammu-hackathon.onrender.com";

const char* DEVICE_ID = "altitude-01";
const char* DEVICE_MODEL = "ESP32-S3";
const char* FIRMWARE_VERSION = "2.4.0-s3-oled";

// ==================== HARDWARE PIN CONFIGURATION ====================
#define ONE_WIRE_BUS   4      // 3x DS18B20 Data pin
#define WATER_PIN      5      // Water Level Analog Pin (GPIO 5)
#define NTC_PIN        1      // NTC Analog Pin (GPIO 1)

#define PUMP_PIN       12     // IRF520 SIG (Pump)
#define PELTIER_PIN    13     // Relay IN (Peltier Cooler)
#define BUZZER_PIN     17     // Buzzer

#define NORMAL_LED_PIN 35     // Normal LED (Active when threshold is met)

#define RED_LED        38     // Red Status LED (Alarm / OverTemp)
#define GREEN_LED      39     // Green Status LED (Normal / Safe)
#define BLUE_LED       40     // Blue Status LED (Wi-Fi Link / Cloud Telemetry)

// ==================== OLED DISPLAY SETTINGS ====================
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET    -1
#define OLED_ADDR     0x3C
#define I2C_SDA       8
#define I2C_SCL       9

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);
bool oledReady = false;
int oledPage = 0;
unsigned long lastPageChange = 0;

// ==================== SENSOR & SAFETY SETTINGS ====================
#define TEMP_LIMIT_ON   35.0    // Cooling ON threshold (Celsius)
#define TEMP_LIMIT_OFF  30.0    // Cooling OFF threshold (Celsius)
#define SERIES_RESISTOR 10000.0 // NTC voltage divider resistor
#define NTC_NOMINAL     10000.0 // 10k NTC
#define TEMP_NOMINAL    25.0
#define B_COEFFICIENT   3950.0

#define WATER_ADC_EMPTY 600
#define WATER_ADC_FULL  2800

// ==================== OBJECTS & GLOBAL VARIABLES ====================
OneWire oneWire(ONE_WIRE_BUS);
DallasTemperature sensors(&oneWire);

WiFiClient clientHttp;
WiFiClientSecure clientHttps;

bool coolingActive = false;
float highestTemp  = -127.0;
float dsTemp[3]    = {-127.0, -127.0, -127.0};
float ntcTemp      = -999.0;
int   ntcRawAdc    = 0;
int   waterRaw     = 0;
float waterPct     = 0.0;

bool isRegistered = false;
int consecutiveFailures = 0;
const int MAX_FAILURES = 3;

unsigned long lastTelemetryMs = 0;
unsigned long lastHeartbeatMs = 0;
unsigned long lastWiFiRetryMs = 0;
const unsigned long TELEMETRY_INTERVAL_MS = 1500; // Telemetry every 1.5s
const unsigned long HEARTBEAT_INTERVAL_MS = 5000; // Heartbeat every 5s

// ----------------------------------------------------
// Helper: Initialize HTTPClient for HTTP or HTTPS
// ----------------------------------------------------
void initHttp(HTTPClient &http, String url) {
  if (url.startsWith("https://")) {
    clientHttps.setInsecure(); // Accept Cloud HTTPS SSL Certificate
    http.begin(clientHttps, url);
  } else {
    http.begin(clientHttp, url);
  }
}

// ----------------------------------------------------
// NTC Steinhart-Hart Calculation (Auto-detects Pull-Up vs Pull-Down wiring)
// ----------------------------------------------------
float readNTCTemp() {
  int adcValue = analogRead(NTC_PIN);
  ntcRawAdc = adcValue;
  // Disconnected / open circuit check (floating near 3.3V or GND)
  if (adcValue <= 150 || adcValue >= 3700) return -999.0;

  // 1. Try Standard Pull-Up: 3.3V -> 10k Resistor -> GPIO 1 -> NTC -> GND
  float resistance = SERIES_RESISTOR * ((4095.0 / (float)adcValue) - 1.0);
  float steinhart = resistance / NTC_NOMINAL;
  steinhart = log(steinhart);
  steinhart /= B_COEFFICIENT;
  steinhart += 1.0 / (TEMP_NOMINAL + 273.15);
  steinhart = 1.0 / steinhart;
  steinhart -= 273.15;

  // 2. If result is negative (< -10C), circuit is wired as Pull-Down divider:
  // 3.3V -> NTC -> GPIO 1 -> 10k Resistor -> GND
  if (steinhart < -10.0) {
    float altResistance = SERIES_RESISTOR / ((4095.0 / (float)adcValue) - 1.0);
    float altSteinhart = altResistance / NTC_NOMINAL;
    altSteinhart = log(altSteinhart);
    altSteinhart /= B_COEFFICIENT;
    altSteinhart += 1.0 / (TEMP_NOMINAL + 273.15);
    altSteinhart = 1.0 / altSteinhart;
    altSteinhart -= 273.15;
    if (altSteinhart > -10.0 && altSteinhart < 85.0) {
      return altSteinhart;
    }
  }

  if (steinhart < -40.0 || steinhart > 85.0) return -999.0;
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
  WiFi.setSleep(false);

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
// Register Device with Cloud Backend
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
  payload += "\"water\":true,";
  payload += "\"peltier\":true,";
  payload += "\"oled\":true";
  payload += "},";
  payload += "\"hasError\":false";
  payload += "}";

  int code = http.POST(payload);
  Serial.printf("[Cloud Backend] Registration -> HTTP %d\n", code);

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
// Send Periodic Heartbeat to Cloud
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
// Stream Live Telemetry to Cloud Backend
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

  bool pumpState      = (digitalRead(PUMP_PIN) == HIGH);
  bool peltierState   = (digitalRead(PELTIER_PIN) == HIGH);
  bool buzzerState    = (digitalRead(BUZZER_PIN) == HIGH);
  bool normalLedState = (digitalRead(NORMAL_LED_PIN) == HIGH);
  bool redState       = (digitalRead(RED_LED) == HIGH);
  bool greenState     = (digitalRead(GREEN_LED) == HIGH);
  bool blueState      = (digitalRead(BLUE_LED) == HIGH);

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
  payload += "\"tempLimitC\":" + String(TEMP_LIMIT_ON, 1) + ",";
  payload += "\"tempLimitOffC\":" + String(TEMP_LIMIT_OFF, 1) + ",";
  payload += "\"overTemp\":" + String(coolingActive ? "true" : "false");
  payload += "},";
  payload += "\"safety\":{";
  payload += "\"overTemp\":" + String(coolingActive ? "true" : "false");
  payload += "},";
  payload += "\"actuators\":{";
  payload += "\"pump\":" + String(pumpState ? "true" : "false") + ",";
  payload += "\"peltier\":" + String(peltierState ? "true" : "false") + ",";
  payload += "\"buzzer\":" + String(buzzerState ? "true" : "false") + ",";
  payload += "\"normalLed\":" + String(normalLedState ? "true" : "false") + ",";
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

// ----------------------------------------------------
// OLED Display Renderer (3 Rotating Pages)
// ----------------------------------------------------
void updateOled(int count) {
  if (!oledReady) return;

  if (millis() - lastPageChange >= 3000) {
    lastPageChange = millis();
    oledPage++;
    if (oledPage > 2) oledPage = 0;
  }

  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);

  if (oledPage == 0) {
    // Page 0: Temperatures
    display.println("--- TEMPERATURES ---");
    for (int i = 0; i < count; i++) {
      display.print("DS"); display.print(i + 1); display.print(": ");
      if (dsTemp[i] <= -126.0) display.println("ERR");
      else { display.print(dsTemp[i], 1); display.println(" C"); }
    }
    display.print("NTC: ");
    if (ntcTemp == -999.0) display.println("ERR");
    else { display.print(ntcTemp, 1); display.println(" C"); }
    
    display.print("Max: ");
    if (highestTemp <= -100.0) display.println("N/A");
    else { display.print(highestTemp, 1); display.println(" C"); }
  }
  else if (oledPage == 1) {
    // Page 1: Water & Hardware
    display.println("--- WATER & SYSTEM ---");
    display.print("Water ADC: "); display.println(waterRaw);
    display.print("Level: "); display.print(waterPct, 1); display.println(" %");
    display.println();
    display.print("DS18B20s : "); display.print(count); display.println(" Probes");
    display.print("Cloud    : ");
    display.println(WiFi.status() == WL_CONNECTED ? "ONLINE" : "OFFLINE");
  }
  else {
    // Page 2: Actuator & Cooling Status
    display.println("--- COOLING STATUS ---");
    display.print("Limit ON : "); display.print(TEMP_LIMIT_ON, 1); display.println(" C");
    display.print("Limit OFF: "); display.print(TEMP_LIMIT_OFF, 1); display.println(" C");
    display.print("Cooling  : "); display.println(coolingActive ? "ACTIVE" : "OFF");
    display.print("Pump     : "); display.println(digitalRead(PUMP_PIN) == HIGH ? "ON" : "OFF");
    display.print("Peltier  : "); display.println(digitalRead(PELTIER_PIN) == HIGH ? "ON" : "OFF");
  }

  display.display();
}

// ==================== SETUP ====================
void setup() {
  Serial.begin(115200);

  unsigned long start = millis();
  while (!Serial && (millis() - start < 3000)) {
    delay(10);
  }

  Serial.println("\n=================================");
  Serial.println("  SMART COOLING & CLOUD SYSTEM");
  Serial.println("=================================");

  // Pin Modes
  pinMode(PUMP_PIN, OUTPUT);
  pinMode(PELTIER_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(NORMAL_LED_PIN, OUTPUT);

  pinMode(RED_LED, OUTPUT);
  pinMode(GREEN_LED, OUTPUT);
  pinMode(BLUE_LED, OUTPUT);

  pinMode(NTC_PIN, INPUT);
  pinMode(WATER_PIN, INPUT);

  // Safe Initial State (All OFF, Green Safe)
  digitalWrite(PUMP_PIN, LOW);
  digitalWrite(PELTIER_PIN, LOW);
  digitalWrite(BUZZER_PIN, LOW);
  digitalWrite(NORMAL_LED_PIN, LOW);
  digitalWrite(RED_LED, LOW);
  digitalWrite(GREEN_LED, HIGH);
  digitalWrite(BLUE_LED, LOW);

  // Initialize OLED on custom I2C Pins (SDA=8, SCL=9)
  Wire.begin(I2C_SDA, I2C_SCL);
  if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    Serial.println("❌ Warning: SSD1306 OLED init failed on 0x3C");
    oledReady = false;
  } else {
    oledReady = true;
    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);
    display.setTextSize(1);
    display.setCursor(0, 10);
    display.println("ALTITUDE SUPERVISOR");
    display.setCursor(0, 25);
    display.println("Firmware v2.4");
    display.setCursor(0, 40);
    display.println("Connecting Wi-Fi...");
    display.display();
  }

  // Initialize DS18B20 1-Wire
  pinMode(ONE_WIRE_BUS, INPUT_PULLUP);
  sensors.begin();
  int count = sensors.getDeviceCount();
  Serial.print("DS18B20 Probes Detected: ");
  Serial.println(count);

  // Connect to Wi-Fi 2.4 GHz
  scanAndConnectWiFi();

  // Initial Cloud Registration
  if (WiFi.status() == WL_CONNECTED) {
    registerWithBackend();
  }

  Serial.println("=================================\n");
}

// ==================== MAIN LOOP ====================
void loop() {
  unsigned long currentMs = millis();

  // 1. Read DS18B20 Digital Probes
  sensors.requestTemperatures();
  int count = sensors.getDeviceCount();

  highestTemp = -127.0;
  for (int i = 0; i < 3; i++) {
    if (i < count) {
      float t = sensors.getTempCByIndex(i);
      dsTemp[i] = t;
      if (t != DEVICE_DISCONNECTED_C && t > -126.0) {
        if (t > highestTemp) highestTemp = t;
      }
    } else {
      dsTemp[i] = -127.0;
    }
  }

  // 2. Read NTC Thermistor (Only if valid and reasonable)
  ntcTemp = readNTCTemp();
  if (ntcTemp != -999.0 && ntcTemp >= -30.0 && ntcTemp <= 85.0) {
    // If DS probes are reading normal room temp (<35C) and NTC differs by >35C, ignore outlier
    if (highestTemp > -100.0 && (ntcTemp - highestTemp > 35.0)) {
      ntcTemp = -999.0;
    } else {
      if (ntcTemp > highestTemp) highestTemp = ntcTemp;
    }
  } else {
    ntcTemp = -999.0;
  }

  // 3. Read Water Level
  waterRaw = analogRead(WATER_PIN);
  waterPct = readWaterLevelPct(waterRaw);

  // 4. Autonomous Hysteresis Cooling Logic
  if (highestTemp >= TEMP_LIMIT_ON) {
    coolingActive = true;
  } else if (highestTemp <= TEMP_LIMIT_OFF && highestTemp > -100.0) {
    coolingActive = false;
  }

  // 5. Apply Actuators
  digitalWrite(PUMP_PIN, coolingActive ? HIGH : LOW);
  digitalWrite(PELTIER_PIN, coolingActive ? HIGH : LOW);
  digitalWrite(BUZZER_PIN, coolingActive ? HIGH : LOW);
  digitalWrite(NORMAL_LED_PIN, coolingActive ? HIGH : LOW);

  if (coolingActive) {
    digitalWrite(RED_LED, HIGH);
    digitalWrite(GREEN_LED, LOW);
  } else {
    digitalWrite(RED_LED, LOW);
    digitalWrite(GREEN_LED, HIGH);
  }

  if (WiFi.status() == WL_CONNECTED) {
    digitalWrite(BLUE_LED, HIGH);
  } else {
    digitalWrite(BLUE_LED, LOW);
  }

  // 6. Refresh OLED Display
  updateOled(count);

  // 7. Serial Console Print
  Serial.println("------ LIVE SYSTEM STATUS ------");
  Serial.printf("Peak Temp: %.2f C | Cooling: %s\n", highestTemp, coolingActive ? "ACTIVE (ON)" : "STANDBY (OFF)");
  Serial.printf("Actuators: Pump=%d | Peltier=%d | Buzzer=%d | NormalLED=%d\n", 
                coolingActive ? 1 : 0, coolingActive ? 1 : 0, coolingActive ? 1 : 0, coolingActive ? 1 : 0);
  Serial.printf("Sensors  : DS1=%.1f C | DS2=%.1f C | DS3=%.1f C | NTC=%.1f C\n",
                dsTemp[0], dsTemp[1], dsTemp[2], ntcTemp);
  Serial.printf("Water    : ADC %d (%.1f %%)\n", waterRaw, waterPct);
  Serial.printf("Wi-Fi    : %s (%s)\n", WiFi.status() == WL_CONNECTED ? "CONNECTED" : "DISCONNECTED",
                WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString().c_str() : "No IP");
  Serial.println("--------------------------------\n");

  // 8. Stream Cloud Telemetry & Heartbeat
  if (currentMs - lastTelemetryMs >= TELEMETRY_INTERVAL_MS) {
    lastTelemetryMs = currentMs;
    sendTelemetry();
  }

  if (currentMs - lastHeartbeatMs >= HEARTBEAT_INTERVAL_MS) {
    lastHeartbeatMs = currentMs;
    sendHeartbeat();
  }

  delay(1200);
}
