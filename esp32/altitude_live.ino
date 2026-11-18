/*
  ============================================================
   SMART TEMPERATURE, PUMP & PELTIER PROTECTION SYSTEM
   ESP32-S3 | Firmware v2.5.0 (LOCALHOST MODE)
  ============================================================

  HARDWARE:
  OLED SSD1306:
    SDA       GPIO 8
    SCL       GPIO 9
    Address   0x3C

  DS18B20:
    All 3 sensors share GPIO 4
    Common 4.7k pull-up resistor from DATA to 3.3V

  Other sensors:
    NTC analog       GPIO 1 (diagnostic only)
    Water sensor    GPIO 5

  Outputs:
    Pump             GPIO 12
    Peltier relay    GPIO 13
    Buzzer           GPIO 17
    Normal LED       GPIO 35

  RGB status LEDs:
    Red              GPIO 38
    Green            GPIO 39
    Blue             GPIO 40

  TEMPERATURE LOGIC:
    Above 27°C       -> Alert ON
    At/below 26°C    -> Alert OFF
    Between 26-27°C  -> Maintain previous state

  SENSOR FAULT:
    All DS18B20 invalid -> Buzzer + Red LED ON
    Pump + Peltier OFF

  NETWORK (LOCALHOST):
    Laptop Hotspot:  192.168.137.1:8080
    POST /api/device/register
    POST /api/device/heartbeat
    POST /api/telemetry
  ============================================================
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

// ============================================================
// 1. WI-FI CONFIGURATION
// ============================================================

// Windows Mobile Hotspot (2.4 GHz)
const char* WIFI_SSID = "jammubhai";
const char* WIFI_PASS = "987654321";

// ============================================================
// 2. LOCALHOST GATEWAY CONFIGURATION
// ============================================================

// Connects to your laptop's local Node.js Gateway via the mobile hotspot IP
const char* SERVER_BASE = "http://192.168.137.1:8080";

const char* DEVICE_ID = "altitude-01";
const char* DEVICE_MODEL = "ESP32-S3";
const char* FIRMWARE_VERSION = "2.5.0-s3-oled";

// ============================================================
// 3. HARDWARE PINS
// ============================================================

#define ONE_WIRE_BUS   4
#define WATER_PIN      5
#define NTC_PIN        1

#define PUMP_PIN       12
#define PELTIER_PIN    13
#define BUZZER_PIN     17

#define NORMAL_LED_PIN 35

#define RED_LED        38
#define GREEN_LED      39
#define BLUE_LED       40

// ============================================================
// 4. OLED CONFIGURATION
// ============================================================

#define SCREEN_WIDTH  128
#define SCREEN_HEIGHT 64
#define OLED_RESET    -1
#define OLED_ADDR     0x3C

#define I2C_SDA       8
#define I2C_SCL       9

Adafruit_SSD1306 display(
  SCREEN_WIDTH,
  SCREEN_HEIGHT,
  &Wire,
  OLED_RESET
);

bool oledReady = false;

int oledPage = 0;
unsigned long lastPageChange = 0;

// ============================================================
// 5. TEMPERATURE & SENSOR SETTINGS
// ============================================================

// Alert starts only when temperature is ABOVE 27°C.
#define TEMP_LIMIT_ON   27.0

// Alert stops at or below 26°C.
#define TEMP_LIMIT_OFF  26.0

// Water sensor calibration from previous code.
#define WATER_ADC_EMPTY 600
#define WATER_ADC_FULL  2800

// ============================================================
// 6. TIMING SETTINGS
// ============================================================

const unsigned long SENSOR_INTERVAL_MS = 1000;
const unsigned long OLED_INTERVAL_MS = 500;
const unsigned long TELEMETRY_INTERVAL_MS = 1500;
const unsigned long HEARTBEAT_INTERVAL_MS = 5000;
const unsigned long WIFI_RETRY_INTERVAL_MS = 10000;

// ============================================================
// 7. SENSOR OBJECTS
// ============================================================

OneWire oneWire(ONE_WIRE_BUS);
DallasTemperature sensors(&oneWire);

// ============================================================
// 8. NETWORK OBJECTS
// ============================================================

WiFiClient clientHttp;
WiFiClientSecure clientHttps;

// ============================================================
// 9. GLOBAL VARIABLES
// ============================================================

float dsTemp[3] = {
  -127.0,
  -127.0,
  -127.0
};

float highestTemp = -127.0;

// NTC is not calibrated.
// It is excluded from temperature control.
int ntcRawAdc = 0;
float ntcTemp = NAN;

int waterRaw = 0;
float waterPct = 0.0;

int validSensors = 0;
int detectedSensors = 0;

bool coolingActive = false;
bool sensorFault = true;
bool isRegistered = false;

int consecutiveFailures = 0;
const int MAX_FAILURES = 3;

unsigned long lastSensorMs = 0;
unsigned long lastOledMs = 0;
unsigned long lastTelemetryMs = 0;
unsigned long lastHeartbeatMs = 0;
unsigned long lastWiFiRetryMs = 0;

// ============================================================
// 10. HTTP INITIALIZATION
// ============================================================

void initHttp(HTTPClient &http, const String &url) {

  if (url.startsWith("https://")) {

    clientHttps.setInsecure();
    http.begin(clientHttps, url);

  } else {

    http.begin(clientHttp, url);

  }
}

// ============================================================
// 11. WATER LEVEL CALCULATION
// ============================================================

float readWaterLevelPct(int rawAdc) {

  if (rawAdc <= 50) {
    return 0.0;
  }

  float percentage =
    ((float)(rawAdc - WATER_ADC_EMPTY) /
     (float)(WATER_ADC_FULL - WATER_ADC_EMPTY)) * 100.0;

  return constrain(percentage, 0.0, 100.0);
}

// ============================================================
// 12. READ TEMPERATURE SENSORS
// ============================================================

void readTemperatureSensors() {

  sensors.requestTemperatures();

  detectedSensors = sensors.getDeviceCount();

  highestTemp = -127.0;
  validSensors = 0;

  for (int i = 0; i < 3; i++) {

    if (i < detectedSensors) {

      float temperature = sensors.getTempCByIndex(i);

      dsTemp[i] = temperature;

      if (
        temperature != DEVICE_DISCONNECTED_C &&
        temperature > -126.0 &&
        temperature < 125.0
      ) {

        validSensors++;

        if (temperature > highestTemp) {
          highestTemp = temperature;
        }

      }

    } else {

      dsTemp[i] = -127.0;

    }
  }

  // NTC diagnostic only.
  // Never include it in highestTemp.
  ntcRawAdc = analogRead(NTC_PIN);
  ntcTemp = NAN;

  // Water sensor
  waterRaw = analogRead(WATER_PIN);
  waterPct = readWaterLevelPct(waterRaw);

  // Sensor fault detection
  sensorFault = (validSensors == 0);

}

// ============================================================
// 13. TEMPERATURE ALERT CONTROL
// ============================================================

void updateTemperatureLogic() {

  // If all DS18B20 sensors fail:
  // Disable cooling equipment for safety.
  if (sensorFault) {

    coolingActive = false;
    return;

  }

  // Alert ON only when temperature is ABOVE 27°C.
  if (highestTemp > TEMP_LIMIT_ON) {

    coolingActive = true;

  }

  // Alert OFF at or below 26°C.
  else if (highestTemp <= TEMP_LIMIT_OFF) {

    coolingActive = false;

  }

  // Between 26°C and 27°C:
  // Keep previous cooling state.
}

// ============================================================
// 14. CONTROL OUTPUTS
// ============================================================

void updateActuators() {

  bool pumpOn = (!sensorFault && coolingActive);
  bool peltierOn = (!sensorFault && coolingActive);

  bool buzzerOn = (sensorFault || coolingActive);

  bool normalLedOn = (!sensorFault && coolingActive);

  digitalWrite(
    PUMP_PIN,
    pumpOn ? HIGH : LOW
  );

  digitalWrite(
    PELTIER_PIN,
    peltierOn ? HIGH : LOW
  );

  digitalWrite(
    BUZZER_PIN,
    buzzerOn ? HIGH : LOW
  );

  digitalWrite(
    NORMAL_LED_PIN,
    normalLedOn ? HIGH : LOW
  );

  // Red LED: Alert or sensor fault.
  digitalWrite(
    RED_LED,
    (sensorFault || coolingActive) ? HIGH : LOW
  );

  // Green LED: Safe condition.
  digitalWrite(
    GREEN_LED,
    (!sensorFault && !coolingActive) ? HIGH : LOW
  );

  // Blue LED: Wi-Fi connected.
  digitalWrite(
    BLUE_LED,
    WiFi.status() == WL_CONNECTED ? HIGH : LOW
  );
}

// ============================================================
// 15. WIFI CONNECTION
// ============================================================

void connectWiFi() {

  Serial.println();
  Serial.println("========== WI-FI ==========");

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);

  WiFi.begin(WIFI_SSID, WIFI_PASS);

  Serial.print("Connecting");

  unsigned long startTime = millis();

  while (
    WiFi.status() != WL_CONNECTED &&
    millis() - startTime < 15000
  ) {

    digitalWrite(
      BLUE_LED,
      !digitalRead(BLUE_LED)
    );

    Serial.print(".");
    delay(300);

  }

  if (WiFi.status() == WL_CONNECTED) {

    digitalWrite(BLUE_LED, HIGH);

    Serial.println();
    Serial.println("Wi-Fi connected!");

    Serial.print("SSID: ");
    Serial.println(WiFi.SSID());

    Serial.print("IP Address: ");
    Serial.println(WiFi.localIP());

    Serial.print("Signal: ");
    Serial.print(WiFi.RSSI());
    Serial.println(" dBm");

  } else {

    digitalWrite(BLUE_LED, LOW);

    Serial.println();
    Serial.println("Wi-Fi connection failed.");
    Serial.println("Running in local mode.");

  }

  Serial.println("===========================");
}

// ============================================================
// 16. WIFI RECONNECTION
// ============================================================

void maintainWiFi() {

  if (WiFi.status() == WL_CONNECTED) {
    return;
  }

  if (
    millis() - lastWiFiRetryMs >=
    WIFI_RETRY_INTERVAL_MS
  ) {

    lastWiFiRetryMs = millis();

    Serial.println("[Wi-Fi] Reconnecting...");

    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASS);

  }

}

// ============================================================
// 17. CLOUD DEVICE REGISTRATION
// ============================================================

bool registerWithBackend() {

  if (WiFi.status() != WL_CONNECTED) {
    return false;
  }

  HTTPClient http;

  String url =
    String(SERVER_BASE) +
    "/api/device/register";

  initHttp(http, url);

  http.addHeader(
    "Content-Type",
    "application/json"
  );

  http.setTimeout(4000);

  String payload = "{";

  payload += "\"deviceId\":\"" + String(DEVICE_ID) + "\",";
  payload += "\"model\":\"" + String(DEVICE_MODEL) + "\",";
  payload += "\"firmware\":\"" + String(FIRMWARE_VERSION) + "\",";
  payload += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
  payload += "\"mac\":\"" + WiFi.macAddress() + "\",";
  payload += "\"status\":\"CONNECTED\",";

  payload += "\"sensors\":{";

  payload += "\"ds18b20Count\":" + String(detectedSensors) + ",";
  payload += "\"ntc\":false,";
  payload += "\"water\":true,";
  payload += "\"peltier\":true,";
  payload += "\"oled\":" + String(oledReady ? "true" : "false");

  payload += "},";

  payload += "\"hasError\":";
  payload += sensorFault ? "true" : "false";

  payload += "}";

  int code = http.POST(payload);

  Serial.printf(
    "[Gateway] Registration HTTP: %d\n",
    code
  );

  bool success =
    (code == 200 || code == 201 || code == 202);

  http.end();

  if (success) {

    isRegistered = true;
    consecutiveFailures = 0;

  } else {

    isRegistered = false;

  }

  return success;
}

// ============================================================
// 18. CLOUD HEARTBEAT
// ============================================================

void sendHeartbeat() {

  if (
    WiFi.status() != WL_CONNECTED ||
    !isRegistered
  ) {
    return;
  }

  HTTPClient http;

  String url =
    String(SERVER_BASE) +
    "/api/device/heartbeat";

  initHttp(http, url);

  http.addHeader(
    "Content-Type",
    "application/json"
  );

  http.setTimeout(3000);

  String payload = "{";

  payload += "\"deviceId\":\"" + String(DEVICE_ID) + "\",";
  payload += "\"model\":\"" + String(DEVICE_MODEL) + "\",";
  payload += "\"status\":\"CONNECTED\",";
  payload += "\"uptimeMs\":" + String(millis()) + ",";
  payload += "\"wifiRssi\":" + String(WiFi.RSSI()) + ",";
  payload += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
  payload += "\"hasError\":";
  payload += sensorFault ? "true" : "false";

  payload += "}";

  int code = http.POST(payload);

  if (code == 200 || code == 202) {

    consecutiveFailures = 0;

  } else {

    consecutiveFailures++;

    if (consecutiveFailures >= MAX_FAILURES) {
      isRegistered = false;
    }

  }

  http.end();
}

// ============================================================
// 19. CLOUD TELEMETRY
// ============================================================

void sendTelemetry() {

  if (WiFi.status() != WL_CONNECTED) {
    return;
  }

  if (!isRegistered) {

    if (!registerWithBackend()) {
      return;
    }

  }

  HTTPClient http;

  String url =
    String(SERVER_BASE) +
    "/api/telemetry";

  initHttp(http, url);

  http.addHeader(
    "Content-Type",
    "application/json"
  );

  http.setTimeout(3500);

  bool pumpState =
    digitalRead(PUMP_PIN) == HIGH;

  bool peltierState =
    digitalRead(PELTIER_PIN) == HIGH;

  bool buzzerState =
    digitalRead(BUZZER_PIN) == HIGH;

  bool normalLedState =
    digitalRead(NORMAL_LED_PIN) == HIGH;

  bool redState =
    digitalRead(RED_LED) == HIGH;

  bool greenState =
    digitalRead(GREEN_LED) == HIGH;

  bool blueState =
    digitalRead(BLUE_LED) == HIGH;

  String payload = "{";

  payload += "\"deviceId\":\"" + String(DEVICE_ID) + "\",";
  payload += "\"model\":\"" + String(DEVICE_MODEL) + "\",";
  payload += "\"deviceStatus\":\"CONNECTED\",";

  payload += "\"sensors\":{";

  payload += "\"highestTempC\":";

  payload +=
    (sensorFault ? "null" : String(highestTemp, 2));

  payload += ",";

  payload += "\"dsTemp1C\":";
  payload +=
    (dsTemp[0] > -126.0 && dsTemp[0] < 125.0)
      ? String(dsTemp[0], 2) : "null";

  payload += ",";

  payload += "\"dsTemp2C\":";
  payload +=
    (dsTemp[1] > -126.0 && dsTemp[1] < 125.0)
      ? String(dsTemp[1], 2) : "null";

  payload += ",";

  payload += "\"dsTemp3C\":";
  payload +=
    (dsTemp[2] > -126.0 && dsTemp[2] < 125.0)
      ? String(dsTemp[2], 2) : "null";

  payload += ",";

  payload += "\"ntcTempC\":null,";
  payload += "\"ntcRawAdc\":" + String(ntcRawAdc) + ",";

  payload += "\"waterAdc\":" + String(waterRaw) + ",";
  payload += "\"waterLevelPct\":" + String(waterPct, 1) + ",";

  payload += "\"tempLimitC\":" + String(TEMP_LIMIT_ON, 1) + ",";
  payload += "\"tempLimitOffC\":" + String(TEMP_LIMIT_OFF, 1) + ",";

  payload += "\"overTemp\":";
  payload += coolingActive ? "true" : "false";

  payload += "},";

  payload += "\"safety\":{";

  payload += "\"overTemp\":";
  payload += coolingActive ? "true" : "false";

  payload += ",";

  payload += "\"sensorFault\":";
  payload += sensorFault ? "true" : "false";

  payload += "},";

  payload += "\"actuators\":{";

  payload += "\"pump\":";
  payload += pumpState ? "true" : "false";

  payload += ",";

  payload += "\"peltier\":";
  payload += peltierState ? "true" : "false";

  payload += ",";

  payload += "\"buzzer\":";
  payload += buzzerState ? "true" : "false";

  payload += ",";

  payload += "\"normalLed\":";
  payload += normalLedState ? "true" : "false";

  payload += ",";

  payload += "\"redLed\":";
  payload += redState ? "true" : "false";

  payload += ",";

  payload += "\"greenLed\":";
  payload += greenState ? "true" : "false";

  payload += ",";

  payload += "\"blueLed\":";
  payload += blueState ? "true" : "false";

  payload += "}}";

  int code = http.POST(payload);

  Serial.printf(
    "[Gateway] Telemetry HTTP: %d\n",
    code
  );

  if (code == 200 || code == 202) {

    consecutiveFailures = 0;

  } else {

    consecutiveFailures++;

    if (consecutiveFailures >= MAX_FAILURES) {
      isRegistered = false;
    }

  }

  http.end();
}

// ============================================================
// 20. OLED DISPLAY
// ============================================================

void updateOled() {

  if (!oledReady) {
    return;
  }

  if (millis() - lastPageChange >= 3000) {

    lastPageChange = millis();

    oledPage++;

    if (oledPage > 2) {
      oledPage = 0;
    }

  }

  display.clearDisplay();

  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);

  // ----------------------------------------------------------
  // PAGE 1: TEMPERATURES
  // ----------------------------------------------------------

  if (oledPage == 0) {

    display.println("--- TEMPERATURES ---");

    for (int i = 0; i < 3; i++) {

      display.print("DS");
      display.print(i + 1);
      display.print(": ");

      if (
        dsTemp[i] <= -126.0 ||
        dsTemp[i] >= 125.0
      ) {

        display.println("ERR");

      } else {

        display.print(dsTemp[i], 1);
        display.println(" C");

      }

    }

    display.print("NTC ADC: ");
    display.println(ntcRawAdc);

    display.print("Max: ");

    if (sensorFault) {

      display.println("N/A");

    } else {

      display.print(highestTemp, 1);
      display.println(" C");

    }

  }

  // ----------------------------------------------------------
  // PAGE 2: WATER AND NETWORK
  // ----------------------------------------------------------

  else if (oledPage == 1) {

    display.println("--- WATER & SYSTEM ---");

    display.print("Water ADC: ");
    display.println(waterRaw);

    display.print("Level: ");
    display.print(waterPct, 1);
    display.println(" %");

    display.println();

    display.print("DS Valid: ");
    display.print(validSensors);
    display.println("/3");

    display.print("WiFi: ");

    display.println(
      WiFi.status() == WL_CONNECTED
        ? "ONLINE"
        : "OFFLINE"
    );

    display.print("Link: ");
    display.println(isRegistered ? "READY" : "WAITING");

  }

  // ----------------------------------------------------------
  // PAGE 3: COOLING STATUS
  // ----------------------------------------------------------

  else {

    display.println("--- COOLING STATUS ---");

    display.print("Limit ON: ");
    display.print(TEMP_LIMIT_ON, 1);
    display.println(" C");

    display.print("Limit OFF: ");
    display.print(TEMP_LIMIT_OFF, 1);
    display.println(" C");

    display.print("Status: ");

    if (sensorFault) {

      display.println("SENSOR FAULT");

    } else {

      display.println(
        coolingActive ? "ALERT ACTIVE" : "SAFE"
      );

    }

    display.print("Pump: ");
    display.println(
      digitalRead(PUMP_PIN) ? "ON" : "OFF"
    );

    display.print("Peltier: ");
    display.println(
      digitalRead(PELTIER_PIN) ? "ON" : "OFF"
    );

  }

  display.display();
}

// ============================================================
// 21. SERIAL MONITOR
// ============================================================

void printSystemStatus() {

  Serial.println();
  Serial.println("========== LIVE SYSTEM STATUS ==========");

  if (sensorFault) {

    Serial.println("WARNING: ALL DS18B20 SENSORS FAILED!");

  } else {

    Serial.printf(
      "Highest DS18B20: %.2f C\n",
      highestTemp
    );

  }

  Serial.printf(
    "Threshold ON: %.1f C | OFF: %.1f C\n",
    TEMP_LIMIT_ON,
    TEMP_LIMIT_OFF
  );

  Serial.printf(
    "Valid DS18B20 sensors: %d/3\n",
    validSensors
  );

  Serial.printf(
    "System: %s\n",
    sensorFault
      ? "SENSOR FAULT"
      : coolingActive
        ? "TEMPERATURE ALERT"
        : "SAFE"
  );

  Serial.printf(
    "DS1: %.2f C | DS2: %.2f C | DS3: %.2f C\n",
    dsTemp[0],
    dsTemp[1],
    dsTemp[2]
  );

  Serial.printf(
    "NTC ADC: %d (diagnostic only)\n",
    ntcRawAdc
  );

  Serial.printf(
    "Water ADC: %d | Water: %.1f%%\n",
    waterRaw,
    waterPct
  );

  Serial.printf(
    "Pump: %s | Peltier: %s | Buzzer: %s\n",
    digitalRead(PUMP_PIN) ? "ON" : "OFF",
    digitalRead(PELTIER_PIN) ? "ON" : "OFF",
    digitalRead(BUZZER_PIN) ? "ON" : "OFF"
  );

  Serial.printf(
    "Red LED: %s | Green LED: %s | Blue LED: %s\n",
    digitalRead(RED_LED) ? "ON" : "OFF",
    digitalRead(GREEN_LED) ? "ON" : "OFF",
    digitalRead(BLUE_LED) ? "ON" : "OFF"
  );

  Serial.printf(
    "Wi-Fi: %s\n",
    WiFi.status() == WL_CONNECTED
      ? "CONNECTED"
      : "DISCONNECTED"
  );

  if (WiFi.status() == WL_CONNECTED) {

    Serial.print("IP: ");
    Serial.println(WiFi.localIP());

  }

  Serial.println("========================================");
}

// ============================================================
// 22. SETUP
// ============================================================

void setup() {

  Serial.begin(115200);

  delay(500);

  Serial.println();
  Serial.println("========================================");
  Serial.println(" SMART COOLING & GATEWAY SYSTEM");
  Serial.println(" ESP32-S3 FIRMWARE v2.5.0 (LOCALHOST)");
  Serial.println("========================================");

  // ----------------------------------------------------------
  // OUTPUT PINS
  // ----------------------------------------------------------

  pinMode(PUMP_PIN, OUTPUT);
  pinMode(PELTIER_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(NORMAL_LED_PIN, OUTPUT);

  pinMode(RED_LED, OUTPUT);
  pinMode(GREEN_LED, OUTPUT);
  pinMode(BLUE_LED, OUTPUT);

  // ----------------------------------------------------------
  // INPUT PINS
  // ----------------------------------------------------------

  pinMode(NTC_PIN, INPUT);
  pinMode(WATER_PIN, INPUT);

  // ----------------------------------------------------------
  // SAFE INITIAL OUTPUT STATE
  // ----------------------------------------------------------

  digitalWrite(PUMP_PIN, LOW);
  digitalWrite(PELTIER_PIN, LOW);
  digitalWrite(BUZZER_PIN, LOW);
  digitalWrite(NORMAL_LED_PIN, LOW);

  digitalWrite(RED_LED, LOW);
  digitalWrite(GREEN_LED, HIGH);
  digitalWrite(BLUE_LED, LOW);

  // ----------------------------------------------------------
  // ADC CONFIGURATION
  // ----------------------------------------------------------

  analogReadResolution(12);

  analogSetPinAttenuation(
    NTC_PIN,
    ADC_11db
  );

  analogSetPinAttenuation(
    WATER_PIN,
    ADC_11db
  );

  // ----------------------------------------------------------
  // OLED INITIALIZATION
  // ----------------------------------------------------------

  Wire.begin(I2C_SDA, I2C_SCL);

  if (
    display.begin(
      SSD1306_SWITCHCAPVCC,
      OLED_ADDR
    )
  ) {

    oledReady = true;

    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);
    display.setTextSize(1);

    display.setCursor(0, 8);
    display.println("ALTITUDE SUPERVISOR");

    display.setCursor(0, 24);
    display.println("ESP32-S3 System");

    display.setCursor(0, 40);
    display.println("Starting...");

    display.display();

    Serial.println("[OLED] Initialized.");

  } else {

    oledReady = false;

    Serial.println("[OLED] Initialization failed.");

  }

  // ----------------------------------------------------------
  // DS18B20 INITIALIZATION
  // ----------------------------------------------------------

  sensors.begin();

  // Avoid long blocking conversions.
  sensors.setResolution(12);
  sensors.setWaitForConversion(true);

  detectedSensors = sensors.getDeviceCount();

  Serial.print("[DS18B20] Detected sensors: ");
  Serial.println(detectedSensors);

  // ----------------------------------------------------------
  // WIFI INITIALIZATION
  // ----------------------------------------------------------

  connectWiFi();

  // ----------------------------------------------------------
  // INITIAL SENSOR READING
  // ----------------------------------------------------------

  readTemperatureSensors();

  updateTemperatureLogic();
  updateActuators();

  // ----------------------------------------------------------
  // INITIAL CLOUD REGISTRATION
  // ----------------------------------------------------------

  if (WiFi.status() == WL_CONNECTED) {
    registerWithBackend();
  }

  // Initialize timers
  lastSensorMs = millis();
  lastOledMs = millis();
  lastTelemetryMs = millis();
  lastHeartbeatMs = millis();

  Serial.println();
  Serial.println("SYSTEM INITIALIZED");
  Serial.println("Temperature control: DS18B20 ONLY");
  Serial.println("Alert threshold: ABOVE 27 C");
  Serial.println("Safe threshold: 26 C OR BELOW");
  Serial.println("========================================");
}

// ============================================================
// 23. MAIN LOOP
// ============================================================

void loop() {

  unsigned long currentMs = millis();

  // ----------------------------------------------------------
  // 1. READ SENSORS
  // ----------------------------------------------------------

  if (
    currentMs - lastSensorMs >=
    SENSOR_INTERVAL_MS
  ) {

    lastSensorMs = currentMs;

    readTemperatureSensors();

    updateTemperatureLogic();

    updateActuators();

    printSystemStatus();

  }

  // ----------------------------------------------------------
  // 2. UPDATE OLED
  // ----------------------------------------------------------

  if (
    currentMs - lastOledMs >=
    OLED_INTERVAL_MS
  ) {

    lastOledMs = currentMs;

    updateOled();

  }

  // ----------------------------------------------------------
  // 3. WIFI MAINTENANCE
  // ----------------------------------------------------------

  maintainWiFi();

  // ----------------------------------------------------------
  // 4. CLOUD TELEMETRY
  // ----------------------------------------------------------

  if (
    currentMs - lastTelemetryMs >=
    TELEMETRY_INTERVAL_MS
  ) {

    lastTelemetryMs = currentMs;

    sendTelemetry();

  }

  // ----------------------------------------------------------
  // 5. CLOUD HEARTBEAT
  // ----------------------------------------------------------

  if (
    currentMs - lastHeartbeatMs >=
    HEARTBEAT_INTERVAL_MS
  ) {

    lastHeartbeatMs = currentMs;

    sendHeartbeat();

  }

  delay(5);
}
