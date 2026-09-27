#!/usr/bin/env bash
curl -sS -X POST http://localhost:8080/api/telemetry \
  -H 'content-type: application/json' \
  -d '{
    "deviceId":"altitude-test",
    "sensors":{"ambientTempC":-12.4,"electronicsTempC":31.7,"coolantTempC":18.1,"humidityPct":24.5,"pressureHpa":650.2,"voltageV":15.4,"currentA":2.18,"powerW":33.57,"waterLevelPct":78},
    "safety":{"eStop":false},
    "actuators":{"pump":true,"peltier":false,"fan":true}
  }'
echo
curl -sS http://localhost:8080/api/latest
echo
