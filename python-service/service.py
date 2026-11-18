#!/usr/bin/env python3
"""ALTITUDE health-analysis service using only the Python standard library."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from datetime import datetime, timezone

HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8000"))


def env_float(name, default):
    try:
        return float(os.getenv(name, default))
    except ValueError:
        return float(default)


TH = {
    "ambient_warn_low": env_float("AMBIENT_WARN_LOW_C", -20),
    "ambient_crit_low": env_float("AMBIENT_CRIT_LOW_C", -35),
    "electronics_warn_high": env_float("ELECTRONICS_WARN_HIGH_C", 65),
    "electronics_crit_high": env_float("ELECTRONICS_CRIT_HIGH_C", 80),
    "coolant_warn_high": env_float("COOLANT_WARN_HIGH_C", 45),
    "coolant_crit_high": env_float("COOLANT_CRIT_HIGH_C", 60),
    "water_warn_low": env_float("WATER_WARN_LOW_PCT", 35),
    "water_crit_low": env_float("WATER_CRIT_LOW_PCT", 20),
    "battery_warn_low": env_float("BATTERY_WARN_LOW_V", 12.8),
    "battery_crit_low": env_float("BATTERY_CRIT_LOW_V", 12.0),
    "battery_crit_high": env_float("BATTERY_CRIT_HIGH_V", 16.9),
}


def number(value):
    try:
        x = float(value)
        return x if math.isfinite(x) else None
    except (TypeError, ValueError):
        return None


def approximate_altitude_m(pressure_hpa):
    """ISA approximation; useful as an indicative value, not a surveyed altitude."""
    p = number(pressure_hpa)
    if p is None or p <= 0:
        return None
    return 44330.0 * (1.0 - (p / 1013.25) ** 0.1903)


def analyze(payload):
    sensors = payload.get("sensors") or {}
    safety = payload.get("safety") or {}
    actuators = payload.get("actuators") or {}

    alerts = []
    severity = 0  # 0 normal, 1 warning, 2 critical
    deductions = 0

    def flag(level, code, message, value=None):
        nonlocal severity, deductions
        severity = max(severity, level)
        deductions += 12 if level == 1 else 30
        alerts.append({"level": "WARNING" if level == 1 else "CRITICAL", "code": code, "message": message, "value": value})

    ambient = number(sensors.get("ambientTempC"))
    electronics = number(sensors.get("electronicsTempC"))
    coolant = number(sensors.get("coolantTempC"))
    water = number(sensors.get("waterLevelPct"))
    voltage = number(sensors.get("voltageV"))
    current = number(sensors.get("currentA"))
    power = number(sensors.get("powerW"))

    # Multi-sensor checks for ESP32 Smart Temp & Pump system
    highest = number(sensors.get("highestTempC"))
    if highest is None:
        cand = [number(sensors.get("dsTemp1C")), number(sensors.get("dsTemp2C")), number(sensors.get("dsTemp3C")), number(sensors.get("ntcTempC")), electronics]
        valid_cands = [x for x in cand if x is not None]
        if valid_cands:
            highest = max(valid_cands)

    temp_limit = number(sensors.get("tempLimitC")) or 35.0
    if highest is not None:
        if highest > temp_limit + 5.0:
            flag(2, "EXTREME_OVERHEAT", f"Peak temperature ({highest:.1f}°C) severely exceeds safety limit ({temp_limit:.1f}°C)! Emergency cooling active.", highest)
        elif highest > temp_limit:
            flag(2, "OVER_TEMPERATURE_ALERT", f"Peak temperature ({highest:.1f}°C) exceeded safety limit ({temp_limit:.1f}°C)! Water pump & buzzer activated.", highest)
        elif highest >= temp_limit - 2.5:
            flag(1, "TEMPERATURE_APPROACHING_LIMIT", f"Peak temperature ({highest:.1f}°C) is nearing safety threshold ({temp_limit:.1f}°C).", highest)

    if ambient is not None:
        if ambient <= TH["ambient_crit_low"]:
            flag(2, "AMBIENT_EXTREME_COLD", "Ambient temperature is below the configured critical limit.", ambient)
        elif ambient <= TH["ambient_warn_low"]:
            flag(1, "AMBIENT_COLD", "Ambient temperature is below the configured warning limit.", ambient)

    if electronics is not None:
        if electronics >= TH["electronics_crit_high"]:
            flag(2, "ELECTRONICS_OVERHEAT", "Protected electronics temperature is critically high.", electronics)
        elif electronics >= TH["electronics_warn_high"]:
            flag(1, "ELECTRONICS_HOT", "Protected electronics temperature is elevated.", electronics)

    if coolant is not None:
        if coolant >= TH["coolant_crit_high"]:
            flag(2, "COOLANT_HOT", "Coolant temperature is critically high.", coolant)
        elif coolant >= TH["coolant_warn_high"]:
            flag(1, "COOLANT_WARM", "Coolant temperature is elevated.", coolant)

    if water is not None:
        if water <= TH["water_crit_low"]:
            flag(2, "COOLANT_LOW", "Coolant/water level is below the critical limit; cooling must be inhibited.", water)
        elif water <= TH["water_warn_low"]:
            flag(1, "COOLANT_LEVEL_WARNING", "Coolant/water level is low.", water)

    if voltage is not None:
        if voltage <= TH["battery_crit_low"] or voltage >= TH["battery_crit_high"]:
            flag(2, "BATTERY_VOLTAGE_CRITICAL", "Battery/bus voltage is outside the configured critical range.", voltage)
        elif voltage <= TH["battery_warn_low"]:
            flag(1, "BATTERY_VOLTAGE_LOW", "Battery/bus voltage is below the configured warning level.", voltage)

    if safety.get("eStop") is True:
        flag(2, "E_STOP", "Emergency stop is active; high-power actuators must remain de-energized.", True)

    # Cross-check commanded/reported actuator state against critical interlocks.
    cooling_inhibited = bool(safety.get("eStop")) or (water is not None and water <= TH["water_crit_low"])
    if cooling_inhibited and (actuators.get("pump") is True or actuators.get("peltier") is True):
        flag(2, "INTERLOCK_MISMATCH", "Cooling actuator is reported ON while a safety interlock requires it OFF.", True)

    if power is None and voltage is not None and current is not None:
        power = voltage * current

    pressure = number(sensors.get("pressureHpa"))
    derived = {
        "powerW": round(power, 3) if power is not None else None,
        "approxAltitudeM": round(approximate_altitude_m(pressure), 1) if pressure is not None else None,
        "coolingInhibited": cooling_inhibited,
    }

    status = "NORMAL" if severity == 0 else "WARNING" if severity == 1 else "CRITICAL"
    health_score = max(0, 100 - deductions)

    return {
        "status": status,
        "healthScore": health_score,
        "alerts": alerts,
        "derived": derived,
        "thresholds": TH,
        "analyzedAt": datetime.now(timezone.utc).isoformat(),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "AltitudeHealth/1.0"

    def _json(self, status, data):
        payload = json.dumps(data, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True, "service": "altitude-python-health", "thresholds": TH})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/analyze":
            self._json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length)
            payload = json.loads(raw.decode() or "{}")
            self._json(200, analyze(payload))
        except Exception as exc:
            self._json(400, {"error": str(exc)})

    def log_message(self, fmt, *args):
        print("[health]", fmt % args)


if __name__ == "__main__":
    print(f"ALTITUDE Python health service listening on http://{HOST}:{PORT}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
