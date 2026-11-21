/**
 * plantAnalyzer.ts — Smart Plant Care & 7-Day Climate Analyzer
 * Owner: P3. Reference implementation of the decision rules.
 *
 * The ESP32 (P2) ports this logic to C++ (decision D1); the web (P4) imports it
 * to show stats and the Thai message. Both must give the same result on mock_data.json.
 *
 * Porting notes for P2:
 *  - Only plain loops, numbers and booleans. No library calls except Math.min/max.
 *  - All thresholds are in THRESHOLDS below (= table D5 in integration-decisions.md).
 *  - Timestamps are UNIX SECONDS (decision D4).
 */

// ---------------------------------------------------------------------------
// Thresholds (single source of truth — keep in sync with integration-decisions.md D5)
// ---------------------------------------------------------------------------
export const THRESHOLDS = {
  SOIL_DRY: 35,                 // soil < 35 %                 -> needs water
  SOIL_FAST_DRY_MIN: 35,        // 35..42 % and drying fast    -> needs water early
  SOIL_FAST_DRY_MAX: 42,
  FAST_DRY_FACTOR: 1.5,         // recent rate > 1.5 x 7-day rate
  RECENT_WINDOW_HOURS: 48,      // "recent" = last 48 h
  SOIL_OVERWATERED: 80,         // soil > 80 %
  OVERWATERED_HOURS: 48,        // ... continuously for >= 48 h
  WATERING_JUMP: 10,            // rise > 10 points between two logs = watering (E1)
  MAX_GAP_HOURS: 3,             // gap > 3 h between logs = device offline, skip pair
  TEMP_HOT: 34,                 // temp > 34 C                 -> move to shade
  TEMP_HOT_DRY_AIR: 32,         // temp > 32 C and RH < 40 %   -> move to shade
  HUM_DRY_AIR: 40,
  TEMP_WARM_MIN: 32,            // 32 < temp <= 34 and ...
  HEAT_STRESS_TEMP: 33,         // hours with temp > 33 C counted as heat stress
  HEAT_STRESS_LIMIT_HOURS: 12,  // ... more than 12 h in 7 days -> move to shade
  HYSTERESIS_EXIT_TEMP: 33,     // optional: once shading, stay until temp < 33 C (D-4)
  LOG_INTERVAL_HOURS: 1,        // one history log per hour (B3)
  WINDOW_SECONDS: 7 * 24 * 3600,
};

// ---------------------------------------------------------------------------
// Types (match the Firebase schema)
// ---------------------------------------------------------------------------
export interface CurrentStatus {
  temperature: number;   // C
  humidity: number;      // % RH
  soil_moisture: number; // %
  updated_at: number;    // UNIX seconds
}

export interface HistoryLog {
  temp: number;
  hum: number;
  soil: number;
  timestamp: number;     // UNIX seconds
}

/** LED codes (decision D2) */
export const LED = { NORMAL: 0, WATER: 1, SHADE: 2, CRITICAL: 3, OVERWATERED: 4 } as const;
export type LedCode = 0 | 1 | 2 | 3 | 4;

export interface Stats { min: number; max: number; avg: number; }

export interface AnalysisResult {
  // 7-day statistics (for the web cards)
  temp: Stats;
  humidity: Stats;
  soil: Stats;
  logCount: number;
  // trend numbers (written to /weekly_summary by the ESP32)
  soil_drying_rate_per_day: number;        // 7-day average, % per day
  recent_drying_rate_per_day: number;      // last 48 h, % per day
  heat_stress_hours_7d: number;
  overwatered_streak_hours: number;        // current streak of soil > 80 %
  // decisions
  recommend_water: boolean;
  recommend_shade: boolean;
  overwatered: boolean;
  led_status: LedCode;
  reasons: string[];                       // English, for debugging / report
  action_message: string;                  // Thai, for the web banner
}

// ---------------------------------------------------------------------------
// Step 1: keep only the last 7 days, sorted by time (decision D4)
// ---------------------------------------------------------------------------
export function filterLast7Days(
  logs: Record<string, HistoryLog> | HistoryLog[] | null | undefined,
  nowSec: number,
): HistoryLog[] {
  if (!logs) return [];
  const list = Array.isArray(logs) ? logs : Object.values(logs);
  const from = nowSec - THRESHOLDS.WINDOW_SECONDS;
  const kept: HistoryLog[] = [];
  for (const l of list) {
    if (l && typeof l.timestamp === "number" && l.timestamp >= from && l.timestamp <= nowSec) {
      kept.push(l);
    }
  }
  kept.sort((a, b) => a.timestamp - b.timestamp);
  return kept;
}

// ---------------------------------------------------------------------------
// Step 2: statistics
// ---------------------------------------------------------------------------
function stats(values: number[]): Stats {
  if (values.length === 0) return { min: 0, max: 0, avg: 0 };
  let min = values[0], max = values[0], sum = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { min, max, avg: round1(sum / values.length) };
}

// ---------------------------------------------------------------------------
// Step 3: soil drying rate, ignoring watering (gap E1)
//   For every pair of consecutive logs:
//     - skip if the gap is > MAX_GAP_HOURS (device was offline)
//     - skip if soil rose by > WATERING_JUMP (someone watered)
//     - otherwise add (prev - cur) to totalDrop and the time to totalHours
//   rate (% per day) = totalDrop / totalHours * 24
// ---------------------------------------------------------------------------
export function dryingRatePerDay(logs: HistoryLog[], fromSec: number): number {
  let totalDrop = 0;
  let totalHours = 0;
  for (let i = 1; i < logs.length; i++) {
    const a = logs[i - 1], b = logs[i];
    if (a.timestamp < fromSec) continue;
    const hours = (b.timestamp - a.timestamp) / 3600;
    if (hours <= 0 || hours > THRESHOLDS.MAX_GAP_HOURS) continue;
    if (b.soil - a.soil > THRESHOLDS.WATERING_JUMP) continue;
    totalDrop += a.soil - b.soil;
    totalHours += hours;
  }
  if (totalHours === 0) return 0;
  return round1((totalDrop / totalHours) * 24);
}

// ---------------------------------------------------------------------------
// Step 4: heat stress hours = number of logs with temp > 33 C x 1 h
// ---------------------------------------------------------------------------
export function heatStressHours(logs: HistoryLog[]): number {
  let count = 0;
  for (const l of logs) if (l.temp > THRESHOLDS.HEAT_STRESS_TEMP) count++;
  return count * THRESHOLDS.LOG_INTERVAL_HOURS;
}

// ---------------------------------------------------------------------------
// Step 5: current overwatered streak (gap E2)
//   Walk backwards from the newest log while soil > 80 % and logs are continuous.
//   Only the streak that is still going on counts: a soggy period 5 days ago
//   that has already dried out should not turn the LED purple today.
// ---------------------------------------------------------------------------
export function overwateredStreakHours(logs: HistoryLog[]): number {
  let streak = 0;
  for (let i = logs.length - 1; i >= 0; i--) {
    if (logs[i].soil <= THRESHOLDS.SOIL_OVERWATERED) break;
    if (i < logs.length - 1) {
      const gapH = (logs[i + 1].timestamp - logs[i].timestamp) / 3600;
      if (gapH > THRESHOLDS.MAX_GAP_HOURS) break;
    }
    streak++;
  }
  return streak * THRESHOLDS.LOG_INTERVAL_HOURS;
}

// ---------------------------------------------------------------------------
// Step 6: combine into one LED code (priority from D2)
// ---------------------------------------------------------------------------
export function pickLed(needWater: boolean, needShade: boolean, overwatered: boolean): LedCode {
  if (needWater && needShade) return LED.CRITICAL;
  if (needWater) return LED.WATER;
  if (needShade) return LED.SHADE;
  if (overwatered) return LED.OVERWATERED;
  return LED.NORMAL;
}

const MESSAGES_TH: Record<LedCode, string> = {
  0: "สภาพแวดล้อมเหมาะสม ไม่ต้องดำเนินการใดๆ",
  1: "ควรรดน้ำตอนนี้ (ดินแห้งกว่าเกณฑ์)",
  2: "ควรย้ายต้นไม้เข้าที่ร่ม (อุณหภูมิสูง/ความร้อนสะสม)",
  3: "ควรรดน้ำทันที และย้ายต้นไม้ออกจากแดดด่วน!",
  4: "งดรดน้ำ ดินแฉะเกินไป วางในที่อากาศถ่ายเท",
};

export function messageFor(code: LedCode): string {
  return MESSAGES_TH[code];
}

// ---------------------------------------------------------------------------
// Main entry point
//   current     : /current_status
//   historyLogs : /history_logs (object from Firebase, or array)
//   nowSec      : current UNIX time in seconds (pass it explicitly — makes testing easy)
//   prevLed     : optional, last LED code; enables heat hysteresis (gap D-4)
// ---------------------------------------------------------------------------
export function analyzePlant(
  current: CurrentStatus,
  historyLogs: Record<string, HistoryLog> | HistoryLog[] | null | undefined,
  nowSec: number = Math.floor(Date.now() / 1000),
  prevLed?: LedCode,
): AnalysisResult {
  const T = THRESHOLDS;
  const logs = filterLast7Days(historyLogs, nowSec);
  const reasons: string[] = [];

  const temps: number[] = [], hums: number[] = [], soils: number[] = [];
  for (const l of logs) { temps.push(l.temp); hums.push(l.hum); soils.push(l.soil); }

  const rate7d = dryingRatePerDay(logs, nowSec - T.WINDOW_SECONDS);
  const rateRecent = dryingRatePerDay(logs, nowSec - T.RECENT_WINDOW_HOURS * 3600);
  const heatHours = heatStressHours(logs);
  const wetStreak = overwateredStreakHours(logs);

  const temp = current.temperature;
  const hum = current.humidity;
  const soil = current.soil_moisture;

  // --- Watering ---
  let needWater = false;
  if (soil < T.SOIL_DRY) {
    needWater = true;
    reasons.push(`soil ${soil}% < ${T.SOIL_DRY}%`);
  } else if (
    soil <= T.SOIL_FAST_DRY_MAX &&
    rate7d > 0 &&
    rateRecent > T.FAST_DRY_FACTOR * rate7d
  ) {
    needWater = true;
    reasons.push(`fast drying: ${rateRecent}%/day vs 7-day ${rate7d}%/day at soil ${soil}%`);
  }

  // --- Overwatered ---
  const overwatered = soil > T.SOIL_OVERWATERED && wetStreak >= T.OVERWATERED_HOURS;
  if (overwatered) reasons.push(`soil > ${T.SOIL_OVERWATERED}% for ${wetStreak} h`);

  // --- Shade / heat ---
  let needShade = false;
  if (temp > T.TEMP_HOT) {
    needShade = true;
    reasons.push(`temp ${temp}C > ${T.TEMP_HOT}C`);
  } else if (temp > T.TEMP_HOT_DRY_AIR && hum < T.HUM_DRY_AIR) {
    needShade = true;
    reasons.push(`temp ${temp}C with dry air ${hum}%RH`);
  } else if (temp > T.TEMP_WARM_MIN && heatHours > T.HEAT_STRESS_LIMIT_HOURS) {
    needShade = true;
    reasons.push(`warm ${temp}C and ${heatHours} h heat stress in 7 days`);
  } else if (
    prevLed !== undefined &&
    (prevLed === LED.SHADE || prevLed === LED.CRITICAL) &&
    temp >= T.HYSTERESIS_EXIT_TEMP
  ) {
    needShade = true;
    reasons.push(`hysteresis: still ${temp}C (exit below ${T.HYSTERESIS_EXIT_TEMP}C)`);
  }

  const led = pickLed(needWater, needShade, overwatered);
  if (led === LED.NORMAL) reasons.push("all values in range");

  return {
    temp: stats(temps),
    humidity: stats(hums),
    soil: stats(soils),
    logCount: logs.length,
    soil_drying_rate_per_day: rate7d,
    recent_drying_rate_per_day: rateRecent,
    heat_stress_hours_7d: heatHours,
    overwatered_streak_hours: wetStreak,
    recommend_water: needWater,
    recommend_shade: needShade,
    overwatered,
    led_status: led,
    reasons,
    action_message: messageFor(led),
  };
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
