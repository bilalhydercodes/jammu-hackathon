from service import analyze

sample = {
    "sensors": {
        "ambientTempC": -12,
        "electronicsTempC": 32,
        "coolantTempC": 19,
        "pressureHpa": 650,
        "voltageV": 15.4,
        "currentA": 2.1,
        "waterLevelPct": 77,
    },
    "safety": {"eStop": False},
    "actuators": {"pump": True, "peltier": False},
}

result = analyze(sample)
assert result["status"] == "NORMAL", result
assert result["derived"]["powerW"] > 30
print(result)
