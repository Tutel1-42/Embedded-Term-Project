# README Gaps & Open Questions — Smart Plant Care

> Review of `README.md` against the course requirements (2110366 Final Project PDF), 13 Nov 2026.
> **Status:** 🔴 Open — needs a team decision · 🟡 Proposed — owner to confirm · 🟢 Resolved
> Decisions that are already settled are in `integration-decisions.md` and listed at the bottom.

---

## A. Critical: could cost us the demo or the grade

### A1. Real trend data needs 7 days of continuous running 🔴
**Problem:** The 7-day rules (heat-stress hours, drying rate) only mean something after about a week of logs. The README doesn't say when the hardware must be running.
**Proposal:** The integration day is **at least 7–10 days before the demo date**. After that, the device runs without stopping (USB power + hotspot).
**Owner:** P3 (schedule), all.
- [ ] Confirm the demo date with the TA
- [ ] Set the integration deadline = demo date − 10 days

### A2. No demo plan for the 4-minute presentation 🔴
**Problem:** The 7-day trend states can't be triggered live in 4 minutes.
**Proposal:** Write a demo script:
- Warm the DHT11 (breath or hand) → 🟡 yellow
- Pull the soil probe out → 🔵 blue
- Do both → 🔴 red
- Put the probe in a cup of water → 🟣 purple (current-value version)
- Switch to a pre-loaded "heat stress week" history to show the trend features on the dashboard

**Owner:** P3 (script), P4 (dashboard view used in the demo).

### A3. ChulaWiFi will likely not work with the ESP32 🔴
**Problem:** University WiFi usually needs a login page or enterprise login, which ESP32 code doesn't handle easily.
**Proposal:** Use a **phone hotspot** for development and the demo. Test it early.
**Owner:** P2.

### A4. Repository must be accessible from the Internet 🔴
**Problem:** The PDF says the repo "must be accessible from the Internet," and we also have to submit a source-code archive. The README only says "manage the Git repository."
**Proposal:** Use a public GitHub repo (or private with the TA added) and the folders `/stm32`, `/esp32`, `/web`, `/analyzer`, `/docs`.
**Owner:** P3.

### A5. We have exactly the minimum of 3 sensor/actuator types 🟡
**Problem:** If one module breaks, the project no longer meets the "≥3 types" requirement.
**Proposal:** Ask the lab whether there's a spare KY-015 / soil module, or add a cheap 4th device (e.g., a buzzer for the critical alert).
**Owner:** P1.

---

## B. Contradictions inside the README (each takes 30 seconds to decide)

| ID | Item | §6.1 says | §8 says | Proposal | Status |
|---|---|---|---|---|---|
| B1 | UART line ending | `\r\n` | `\n` | Send `\n`; parser ignores `\r` | 🔴 |
| B2 | Baud rate | — | "115200 (or 9600)" | **115200** only | 🔴 |
| B3 | History log interval | "every 15–60 min" | P2: "hourly" | **Hourly** (1 log = 1 heat-stress hour) | 🔴 |
| B4 | Blue status pins | `(0,0,1)` or `(0,1,1)` | — | Pick one | 🔴 |
| B5 | Red status | "Red / Blinking Red" | — | Decide whether it blinks | 🔴 |

---

## C. Gap created by decision D1 (ESP32 computes the trend)

### C1. Which LED status wins on the STM32? 🔴
**Problem:** The STM32 recalculates its own status `L` every 5 s, but the ESP32 only sends `C` when the status changes. As currently written, the STM32's local result overwrites the ESP32's command 5 seconds later.
**Proposal:** The STM32 shows the last `C` value **if it was received within the last 10 minutes**. Otherwise it falls back to its own `L`. The ESP32 resends `C` every 5 minutes even if nothing changed, so the 10-minute window stays valid. This also keeps the LED useful if WiFi drops.
**Owner:** P1 + P2.

---

## D. Hardware traps

### D-1. STM32 UART port conflict 🟡 (P1)
On the Nucleo-F411RE, **USART2 (PA2/PA3) is wired to the ST-LINK USB serial** that P1 uses for testing. Use **USART1 (PA9/PA10) or USART6** for the ESP32 link, and keep USART2 for debug printing.

### D-2. ESP32-S3 UART port 🟡 (P2)
UART0 is the USB console. Use `Serial1` with custom pins for the STM32 link.

### D-3. Soil sensor voltage and direction 🟡 (P1)
- Power the soil module from **3.3 V, not 5 V**. On 5 V, its analog output can go above what the STM32 ADC accepts.
- Many modules read a **higher ADC value when drier**, so the conversion to % may need to run in reverse. Calibrate `OpenAirReading` / `WaterReading` on the real module.

### D-4. DHT11 accuracy vs. our thresholds 🟡 (P1, P2, P3)
KY-015 is a DHT11: it measures whole degrees with **±2 °C accuracy**. Our thresholds (32 / 33 / 34 °C) are within that error, so the LED could flicker between colors.
**Proposal:** add **hysteresis**: enter "hot" at > 34 °C and exit at < 33 °C, or require 3 readings in a row before changing state.
Also: the DHT11 needs microsecond timing (use a hardware timer), and it should be read at most once per second.

---

## E. Analytics definitions (P3 will define these in `plantAnalyzer.ts`)

### E1. Drying rate must ignore watering 🟡
Averaging all changes makes every watering hide the real drying rate. Proposal: only count moisture **drops between watering events** (a rise of > 10 % = a watering).

### E2. Overwatered "> 48 h" 🟡
Read as **48 h continuously above 80 %, and still ongoing now**, not 48 h in total. (This is how `plantAnalyzer.ts` implements it: a soggy period that has already dried out does not turn the LED purple.)

### E3. Mock data cleanup 🟡
Mock logs age out of the 7-day window by themselves, but **delete `/history_logs` on the integration day** so the charts only show real data.

---

## 🟢 Already resolved (see `integration-decisions.md`)
- **D1** The ESP32 computes the 7-day trend and the final LED status (not the website).
- **D2** `led_status` is a number, 0–4, everywhere.
- **D3** The ESP32 writes the status and trend fields; the website writes the Thai message text and min/max/avg.
- **D4** Timestamps are UNIX **seconds**; every reader filters to the last 7 days.
- **D5** Single threshold table.

---

### How to close a gap
Reply in the group with the ID and your choice (e.g., `B2: 115200`). P3 will move it into `integration-decisions.md` and mark it 🟢 here.
