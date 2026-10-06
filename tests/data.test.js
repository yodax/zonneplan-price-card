import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeForecast, forecastFromAttributes, cheapestWindow, niceStep, aggregateHourly } from "../zonneplan-price-card.js";

const Q = 15 * 60000;
const H = 3600000;
const T0 = Date.parse("2026-10-06T00:00:00+02:00");

// Synthetic quarter-hourly forecast in the Zonneplan ONE shape (amounts in 1e-7 EUR).
function zonneplanQuarter(pricesCt) {
  return pricesCt.map((ct, i) => ({
    start_date: new Date(T0 + i * Q).toISOString(),
    end_date: new Date(T0 + (i + 1) * Q).toISOString(),
    price_tax_included: { amount: Math.round(ct * 1e5) },
    price_tax_excluded: { amount: Math.round(ct * 0.7 * 1e5) },
    sustainability_score: { permille: 500 },
  }));
}

test("normalizes Zonneplan quarter-hourly amounts to cents", () => {
  const s = normalizeForecast(zonneplanQuarter([37.57883, 40.2]));
  assert.equal(s.length, 2);
  assert.equal(s[0].e - s[0].s, Q);
  assert.ok(Math.abs(s[0].p - 37.57883) < 1e-6);
  assert.ok(Math.abs(s[0].px - 37.57883 * 0.7) < 1e-4);
});

test("normalizes Zonneplan hourly shape and fills end from next start", () => {
  const items = [0, 1].map((i) => ({
    datetime: new Date(T0 + i * H).toISOString(),
    electricity_price: 4096865,
    electricity_price_excl_tax: 2988384,
    tariff_group: "normal",
  }));
  const s = normalizeForecast(items);
  assert.equal(s[0].e, T0 + H);
  assert.equal(s[1].e, T0 + 2 * H);
  assert.ok(Math.abs(s[0].p - 40.96865) < 1e-6);
});

test("generic EUR/kWh values are scaled to cents; explicit factor wins", () => {
  const items = [{ start: new Date(T0).toISOString(), end: new Date(T0 + H).toISOString(), value: 0.25 }];
  assert.equal(normalizeForecast(items)[0].p, 25);
  assert.equal(normalizeForecast(items, 1000)[0].p, 250);
});

test("Nord Pool raw_today + raw_tomorrow are concatenated", () => {
  const a = { raw_today: [{ start: "a", end: "b", value: 1 }], raw_tomorrow: [{ start: "c", end: "d", value: 2 }] };
  assert.equal(forecastFromAttributes(a).length, 2);
  assert.equal(forecastFromAttributes({ forecast: [1] }).length, 1);
  assert.deepEqual(forecastFromAttributes({ x: [1, 2] }, "x"), [1, 2]);
});

test("cheapestWindow finds the cheapest contiguous 2h block on quarter slots", () => {
  // 24h of 40 ct with a 2h dip of 30 ct starting at 12:30.
  const prices = Array.from({ length: 96 }, (_, i) => (i >= 50 && i < 58 ? 30 : 40));
  const slots = normalizeForecast(zonneplanQuarter(prices));
  const w = cheapestWindow(slots, 2, T0 + 60000);
  assert.equal(w.start, T0 + 50 * Q);
  assert.equal(w.end, T0 + 58 * Q);
  assert.ok(Math.abs(w.avg - 30) < 1e-9);
});

test("cheapestWindow starts at the slot containing now, respects until and gaps", () => {
  const prices = Array.from({ length: 16 }, (_, i) => 50 - i); // falling prices
  const slots = normalizeForecast(zonneplanQuarter(prices));
  // until = 2h after T0 limits the search to the first 2h
  const w = cheapestWindow(slots, 1, T0 + 5 * 60000, T0 + 2 * H);
  assert.equal(w.end, T0 + 2 * H);
  // a gap prevents a block from spanning it
  const gapped = slots.filter((_, i) => i !== 6);
  const g = cheapestWindow(gapped, 1, T0, Infinity);
  assert.ok(g.start >= T0 + 7 * Q);
  // nothing long enough
  assert.equal(cheapestWindow(slots, 6, T0), null);
});

test("cheapestWindow can use excl.-tax prices", () => {
  const slots = [
    { s: 0, e: H, p: 10, px: 50 },
    { s: H, e: 2 * H, p: 20, px: 5 },
  ];
  assert.equal(cheapestWindow(slots, 1, 0).start, 0);
  assert.equal(cheapestWindow(slots, 1, 0, Infinity, "px").start, H);
});

test("niceStep keeps the grid to about four lines", () => {
  assert.equal(niceStep(62), 20);
  assert.equal(niceStep(15), 5);
  assert.equal(niceStep(150), 50);
});

test("aggregateHourly averages quarters into clock hours", () => {
  const T = new Date(2026, 9, 6, 10, 0, 0).getTime(); // local 10:00
  const slots = [10, 20, 30, 40, 50, 60, 70, 80].map((p, i) => ({ s: T + i * Q, e: T + (i + 1) * Q, p, px: p / 2 }));
  const h = aggregateHourly(slots);
  assert.equal(h.length, 2);
  assert.deepEqual([h[0].s, h[0].e, h[0].p, h[0].px], [T, T + H, 25, 12.5]);
  assert.equal(h[1].p, 65);
  // a partial first hour keeps its real start; a missing px makes the hour's px null
  const part = aggregateHourly([{ s: T + 2 * Q, e: T + 3 * Q, p: 5, px: null }, { s: T + 3 * Q, e: T + H, p: 15, px: 1 }]);
  assert.deepEqual([part[0].s, part[0].p, part[0].px], [T + 2 * Q, 10, null]);
});
