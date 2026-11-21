# Integration Decisions (agreed 13 Nov 2026)

These decisions **override** README sections 6 and 8 wherever they conflict.

## D1. The ESP32 computes the 7-day trend (not the website)
**Why:** the website only runs while someone has it open. Cloud Functions need the paid Blaze plan, and we are on Spark.

- The ESP32 reads `/history_logs` and keeps only entries with `timestamp >= now - 7*86400`. From those it calculates:
  - `heat_stress_hours_7d`: number of hourly logs with `temp > 33`
  - `soil_drying_rate_per_day`: average soil decrease per day over 7 days, plus the recent rate over the last 24–48 h (for the fast-drying rule)
- The ESP32 combines the current values with the trend into one **final status (0–4)**. It writes the status to Firebase and sends `C<status>\n` to the STM32 **only when it changes**.
- `plantAnalyzer.ts` (P3) is the **reference implementation**. P2 ports the same thresholds to C++. Both versions must return identical results on `mock_data.json`.

## D2. `led_status` is a number, 0–4, everywhere
| Code | Color | Meaning |
|:---:|:---|:---|
| 0 | Green | Normal |
| 1 | Blue | Needs water |
| 2 | Yellow | Move to shade |
| 3 | Red | Water **and** move to shade |
| 4 | Purple | Overwatered |

When several rules are true at once, use this priority:
1. needWater && needShade → 3
2. needWater → 1
3. needShade → 2
4. overwatered → 4
5. otherwise → 0

## D3. Who writes which fields
| Path / field | Writer |
|:---|:---|
| `current_status.temperature`, `humidity`, `soil_moisture`, `updated_at` | ESP32 (P2) |
| `current_status.led_status`, `recommend_water`, `recommend_shade` | ESP32 (P2), after the D1 analysis |
| `weekly_summary.heat_stress_hours_7d`, `soil_drying_rate_per_day` | ESP32 (P2) |
| `history_logs/*` (hourly) + deletion of entries older than 7 days | ESP32 (P2) |
| Thai `action_message` text, min/max/avg | **Web (P4)**, derived from `led_status` and the logs using `plantAnalyzer.ts`. The ESP32 does not send Thai text. |

## D4. Time and filtering
- Every `timestamp` / `updated_at` is a **UNIX timestamp in seconds**. JavaScript code must multiply by 1000 before using `Date`.
- **Every reader filters by the last 7 days** and never assumes that old entries have been deleted.
- `history_logs` keys use the format `YYYY-MM-DD_HH-MM` (Asia/Bangkok local time). The `timestamp` field is the value used for ordering and filtering (it is indexed in the rules).

## D5. Thresholds (single source of truth)
| Name | Value |
|:---|:---|
| SOIL_DRY | < 35 % |
| SOIL_FAST_DRY_RANGE | 35–42 % and recent drying rate > 1.5 × the 7-day average rate |
| SOIL_OVERWATERED | > 80 % for more than 48 h within 7 days |
| TEMP_HOT | > 34 °C, or > 32 °C with RH < 40 % |
| TEMP_WARM_RANGE | 32–34 °C and `heat_stress_hours_7d` > 12 |
| HEAT_STRESS_TEMP | > 33 °C |

If a threshold changes, update this table first. Then update `plantAnalyzer.ts` and the ESP32 code together.
