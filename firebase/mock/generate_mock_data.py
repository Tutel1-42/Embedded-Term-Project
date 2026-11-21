"""Generate 7 days of hourly mock data for the Smart Plant Care Firebase RTDB.

Usage:  python generate_mock_data.py            -> writes mock_data.json
Import: Firebase console > Realtime Database > Data > (three dots) > Import JSON

Built-in scenarios (so plantAnalyzer can be tested immediately):
  * Day 1      : soil > 80%      -> overwatered case
  * Days 3-4   : heat wave, ~13 h above 33 C  -> 7-day heat stress (> 12 h)
  * Last 48 h  : soil drops fast, ends ~39%   -> fast-drying case (35-42%)
Timestamps are UNIX SECONDS (not milliseconds). Keys use Asia/Bangkok local time.
"""
import json
import math
import random
from datetime import datetime, timedelta, timezone

random.seed(42)
BKK = timezone(timedelta(hours=7))
HOURS = 168

now = datetime.now(BKK).replace(minute=0, second=0, microsecond=0)
start = now - timedelta(hours=HOURS - 1)

logs = {}
soil = 85.0
for i in range(HOURS):
    t = start + timedelta(hours=i)
    day = i // 24  # 0..6
    hour = t.hour

    # Temperature: daily sine wave, peak ~14:00
    base = 28.5 + 4.5 * math.sin((hour - 8) / 24 * 2 * math.pi)
    if day in (3, 4) and 11 <= hour <= 17:      # heat wave afternoons
        base += 4.0
    temp = round(base + random.uniform(-0.6, 0.6), 1)

    # Humidity: inverse of temperature
    hum = round(max(30, min(90, 110 - 1.6 * temp + random.uniform(-3, 3))), 1)

    # Soil moisture: drying with occasional watering
    hours_left = HOURS - i
    if hours_left <= 48:
        rate = 0.85                   # fast drying at the end
    elif temp > 33:
        rate = 0.6
    else:
        rate = 0.25
    if day == 0:
        rate = 0.05                   # stays soggy on day 1 (overwatered)
    soil -= rate
    if i in (40, 100):                # watering events
        soil = 72.0
    if hours_left == 48:
        soil = 80.0                   # watering, then fast drying for 48 h
    soil = round(max(0, min(100, soil + random.uniform(-0.3, 0.3))), 1)

    key = t.strftime("%Y-%m-%d_%H-%M")
    logs[key] = {"temp": temp, "hum": hum, "soil": soil,
                 "timestamp": int(t.timestamp())}

vals = list(logs.values())
temps = [v["temp"] for v in vals]
soils = [v["soil"] for v in vals]
last = vals[-1]

data = {
    "current_status": {
        "temperature": last["temp"],
        "humidity": last["hum"],
        "soil_moisture": last["soil"],
        "led_status": 0,                 # 0-4, written by ESP32 (see D2)
        "recommend_water": False,
        "recommend_shade": False,
        "action_message": "mock data - waiting for plantAnalyzer",
        "updated_at": last["timestamp"],
    },
    "weekly_summary": {
        "temp_min": min(temps),
        "temp_max": max(temps),
        "temp_avg": round(sum(temps) / len(temps), 1),
        "soil_min": min(soils),
        "soil_max": max(soils),
        "soil_avg": round(sum(soils) / len(soils), 1),
        "soil_drying_rate_per_day": None,  # plantAnalyzer computes this
        "heat_stress_hours_7d": sum(1 for x in temps if x > 33),
    },
    "history_logs": logs,
}

with open("mock_data.json", "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

print(f"{len(logs)} logs | heat>33C hours: {data['weekly_summary']['heat_stress_hours_7d']}"
      f" | current soil: {last['soil']}% | temp {last['temp']}C")
