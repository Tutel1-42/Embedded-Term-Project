# analyzer — 7-day plant trend analyzer (P3)

`plantAnalyzer.ts` is the **reference implementation** of every decision rule in the project:
min/max/avg stats, soil drying rate, heat-stress hours, and the final LED status (0–4).

- **P4 (web)** imports it to show stats and the Thai action message.
- **P2 (ESP32)** ports the same logic to C++ (see `docs/integration-decisions.md`, D1).
  Both versions must give the same result on `firebase/mock/mock_data.json`.

## Run
```bash
cd analyzer
npm install          # first time only (needs Node 22+)
npm test             # 16 tests, incl. one on the mock data
npm run typecheck    # TypeScript type check (same as VS Code)
```

## Use
```ts
import { analyzePlant } from "./plantAnalyzer.ts";

const r = analyzePlant(current_status, history_logs, nowSec, prevLed);
r.led_status;      // 0-4
r.action_message;  // Thai text for the banner
r.temp, r.soil;    // { min, max, avg } over the last 7 days
```
- `nowSec`: current UNIX time in **seconds**. Pass it explicitly in tests.
- `prevLed` (optional): the last LED code. Turns on heat hysteresis (stay yellow until < 33 °C). The ESP32 should pass it; the web doesn't need to.

## Rules at a glance
All numbers live in the `THRESHOLDS` object at the top of `plantAnalyzer.ts`,
which mirrors table **D5** in `docs/integration-decisions.md`. Change both together.

| Rule | Condition |
|---|---|
| Needs water | soil < 35 %, **or** soil 35–42 % and the last-48 h drying rate > 1.5 × the 7-day rate |
| Move to shade | temp > 34 °C, **or** > 32 °C with RH < 40 %, **or** > 32 °C with > 12 heat-stress hours (> 33 °C) in 7 days |
| Overwatered | soil > 80 % for ≥ 48 h in a row, still ongoing |
| LED priority | water + shade → 3, water → 1, shade → 2, overwatered → 4, else 0 |

Notes on how the trend is calculated:
- **Drying rate** skips pairs of logs where the soil rose by > 10 points (a watering) or where the gap is > 3 h (the device was offline).
- **Heat-stress hours** = number of logs above 33 °C × 1 h, so it assumes **one log per hour**.
