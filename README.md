# ALTITUDE — SIH 2026 Live Prototype Website

This package is the hackathon presentation build: the **live monitoring website and the 3D ALTITUDE prototype are in the same portal**.

## What opens in the website

- Overview for the judge
- Live sensor dashboard
- Interactive 3D prototype recreated from the Blender design
- System architecture
- Alerts and recent packets
- Operator commands for pump, Peltier and radiator fan

The 3D view works immediately in the browser; you do **not** need to export a GLB for the demo. The original Blender generator and the web-export variant are both included under `blender/`.

## Fastest start — Windows

Double-click:

```text
START_HACKATHON.bat
```

The first run installs the Next.js dependencies. Then open:

```text
http://localhost:3000
```

## macOS / Linux

```bash
./start-hackathon.sh
```

Or manually:

```bash
npm run setup
npm run dev
```

## Demo mode and real hardware mode

The Node gateway generates realistic **DEMO MODE** packets automatically so the presentation never starts blank.

When the ESP32 sends a packet to:

```text
POST http://YOUR_LAPTOP_IP:8080/api/telemetry
```

the website automatically changes to **REAL HARDWARE**. If hardware packets stop for more than 12 seconds, demo telemetry resumes.

## ESP32

Edit `esp32/altitude_live.ino`:

```cpp
const char* WIFI_SSID = "YOUR_WIFI";
const char* WIFI_PASS = "YOUR_PASSWORD";
const char* SERVER_BASE = "http://YOUR_LAPTOP_IP:8080";
```

Use the laptop's LAN/Wi-Fi IP, not `localhost`. The laptop and ESP32 must be on the same network.

The firmware sends BME280, DS18B20, 100K NTC, INA260 and water-level readings approximately once per second.

## Services

- Next.js UI: `:3000`
- Node.js telemetry gateway: `:8080`
- Python health engine: `:8000`

## Safety

The portal is a prototype operator interface. Keep the emergency-stop and NC safety relay hardware independent of software control.
