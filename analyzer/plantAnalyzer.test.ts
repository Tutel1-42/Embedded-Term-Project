// Run: node --experimental-strip-types --test plantAnalyzer.test.ts
//   (or: npx tsx --test plantAnalyzer.test.ts)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyzePlant, LED, type HistoryLog, type CurrentStatus } from "./plantAnalyzer.ts";

const NOW = 1_800_000_000; // fixed "now" so tests never depend on the clock
const H = 3600;

/** Build hourly logs ending at NOW. f(hoursAgo) returns {temp, hum, soil}. */
function makeLogs(hours: number, f: (h: number) => Omit<HistoryLog, "timestamp">): HistoryLog[] {
  const logs: HistoryLog[] = [];
  for (let h = hours - 1; h >= 0; h--) logs.push({ ...f(h), timestamp: NOW - h * H });
  return logs;
}
function cur(temp: number, hum: number, soil: number): CurrentStatus {
  return { temperature: temp, humidity: hum, soil_moisture: soil, updated_at: NOW };
}
/** Normal week: 28 C, 60 %RH, soil drying 0.25 %/h from 70 %. */
const normalWeek = makeLogs(168, (h) => ({ temp: 28, hum: 60, soil: 30 + h * 0.25 }));

test("normal -> green (0)", () => {
  const r = analyzePlant(cur(28, 60, 55), normalWeek, NOW);
  assert.equal(r.led_status, LED.NORMAL);
  assert.equal(r.logCount, 168);
  assert.equal(r.soil_drying_rate_per_day, 6); // 0.25 %/h * 24
});

test("soil < 35 % -> blue (1)", () => {
  const r = analyzePlant(cur(28, 60, 30), normalWeek, NOW);
  assert.equal(r.led_status, LED.WATER);
});

test("fast drying at 40 % -> blue (1)", () => {
  // slow 0.2 %/h for 5 days, then 0.6 %/h for the last 48 h
  const logs = makeLogs(168, (h) => ({
    temp: 29, hum: 60, soil: h >= 48 ? 40 + 48 * 0.6 + (h - 48) * 0.2 : 40 + h * 0.6,
  }));
  const r = analyzePlant(cur(29, 60, 40), logs, NOW);
  assert.ok(r.recent_drying_rate_per_day > 1.5 * r.soil_drying_rate_per_day);
  assert.equal(r.led_status, LED.WATER);
});

test("same 40 % but normal drying speed -> green (0)", () => {
  const r = analyzePlant(cur(28, 60, 40), normalWeek, NOW);
  assert.equal(r.led_status, LED.NORMAL);
});

test("watering jumps are ignored in the drying rate", () => {
  // dries 0.25 %/h, watered back up to 70 % every 2 days
  const logs = makeLogs(168, (h) => ({ temp: 28, hum: 60, soil: 58 + (h % 48) * 0.25 }));
  const r = analyzePlant(cur(28, 60, 60), logs, NOW);
  assert.equal(r.soil_drying_rate_per_day, 6);
});

test("temp > 34 C -> yellow (2)", () => {
  const r = analyzePlant(cur(35, 60, 55), normalWeek, NOW);
  assert.equal(r.led_status, LED.SHADE);
});

test("33 C with dry air (< 40 %RH) -> yellow (2)", () => {
  const r = analyzePlant(cur(33, 35, 55), normalWeek, NOW);
  assert.equal(r.led_status, LED.SHADE);
});

test("33 C after a hot week (> 12 h heat stress) -> yellow (2)", () => {
  const hotWeek = makeLogs(168, (h) => ({ temp: h % 24 < 3 ? 35 : 28, hum: 60, soil: 30 + h * 0.25 }));
  const r = analyzePlant(cur(33, 60, 55), hotWeek, NOW);
  assert.equal(r.heat_stress_hours_7d, 21); // 3 h/day * 7 days
  assert.equal(r.led_status, LED.SHADE);
});

test("33 C after a mild week -> green (0)", () => {
  const r = analyzePlant(cur(33, 60, 55), normalWeek, NOW);
  assert.equal(r.led_status, LED.NORMAL);
});

test("dry and hot -> red (3)", () => {
  const r = analyzePlant(cur(36, 50, 25), normalWeek, NOW);
  assert.equal(r.led_status, LED.CRITICAL);
});

test("soil > 80 % for 48 h -> purple (4)", () => {
  const logs = makeLogs(168, (h) => ({ temp: 27, hum: 70, soil: h < 60 ? 85 : 60 }));
  const r = analyzePlant(cur(27, 70, 85), logs, NOW);
  assert.equal(r.overwatered_streak_hours, 60);
  assert.equal(r.led_status, LED.OVERWATERED);
});

test("soil > 80 % for only 20 h -> green (0)", () => {
  const logs = makeLogs(168, (h) => ({ temp: 27, hum: 70, soil: h < 20 ? 85 : 60 }));
  const r = analyzePlant(cur(27, 70, 85), logs, NOW);
  assert.equal(r.led_status, LED.NORMAL);
});

test("hysteresis keeps yellow at 33.5 C if it was yellow before", () => {
  assert.equal(analyzePlant(cur(33.5, 60, 55), normalWeek, NOW, LED.SHADE).led_status, LED.SHADE);
  assert.equal(analyzePlant(cur(32.5, 60, 55), normalWeek, NOW, LED.SHADE).led_status, LED.NORMAL);
});

test("logs older than 7 days and offline gaps are ignored", () => {
  const old = makeLogs(5, () => ({ temp: 40, hum: 60, soil: 50 })).map((l) => ({
    ...l, timestamp: l.timestamp - 8 * 24 * H,
  }));
  const r = analyzePlant(cur(33, 60, 55), [...old, ...normalWeek], NOW);
  assert.equal(r.logCount, 168);
  assert.equal(r.heat_stress_hours_7d, 0);
});

test("empty history still works (current values only)", () => {
  assert.equal(analyzePlant(cur(28, 60, 30), null, NOW).led_status, LED.WATER);
  assert.equal(analyzePlant(cur(28, 60, 50), {}, NOW).led_status, LED.NORMAL);
});

test("mock_data.json -> blue (fast drying), heat stress > 12 h", () => {
  const data = JSON.parse(readFileSync(new URL("../firebase/mock/mock_data.json", import.meta.url), "utf8"));
  const logs = Object.values(data.history_logs) as HistoryLog[];
  const now = Math.max(...logs.map((l) => l.timestamp)); // mock was made on 13 Nov
  const r = analyzePlant(data.current_status, data.history_logs, now);
  console.log("mock result:", JSON.stringify({ ...r, temp: undefined, humidity: undefined, soil: undefined }));
  assert.equal(r.logCount, 168);
  assert.ok(r.heat_stress_hours_7d > 12);
  assert.equal(r.led_status, LED.WATER);
});
