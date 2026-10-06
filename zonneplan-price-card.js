// zonneplan-price-card — dynamic energy price chart for Home Assistant, styled after the
// Zonneplan app: a stepped price line with min/max labels, a "find the cheapest N hours"
// selector, and a scrub tooltip when you drag across the chart.
//
// Works with the 15-minute (and hourly) tariff forecast exposed by the Zonneplan ONE
// integration, and with generic forecast attributes ({start, end, value}-style lists,
// Nord Pool's raw_today/raw_tomorrow). See README.md for configuration.

export const VERSION = "0.2.0";

const HOUR = 3600000;

const STRINGS = {
  nl: {
    title: "Energieprijzen",
    all: "Alle",
    find: "Vind de goedkoopste reeks uren",
    to: "tot",
    hour: "uur",
    now: "nu",
    min: "min",
    tomorrow: "morgen",
    noData: "Geen prijsdata beschikbaar",
    horizon: "Zoeken binnen",
    horizonAll: "Alles",
    prices: "Prijzen",
    incl: "Incl. belasting",
    excl: "Excl. belasting",
    noWindow: "Geen aaneengesloten blok gevonden",
    view: "Weergave",
    hours: "Uren",
    quarters: "Kwartieren",
    viewDesc: "Toon prijzen in de grafiek per kwartier of per uur. Stroomafrekening gebeurt altijd per kwartier.",
    decimals: "Decimalen centen",
    decimalsDesc: "Aantal cijfers achter de komma om prijsverschillen nauwkeuriger te bekijken.",
    tax: "Energiebelasting",
    taxDesc: "Weergave van prijzen met of zonder energiebelasting. Alleen van toepassing op de prijsgrafiek.",
    remaining: "Resterende uren",
    remainingDesc: "Toon het aantal resterende uren, bijvoorbeeld voor het instellen van een wasmachine of droger.",
    horizonDesc: "Zoek het goedkoopste blok alleen binnen deze periode.",
    hourShort: "u",
  },
  en: {
    title: "Energy prices",
    all: "All",
    find: "Find the cheapest block of hours",
    to: "to",
    hour: "h",
    now: "now",
    min: "min",
    tomorrow: "tomorrow",
    noData: "No price data available",
    horizon: "Search within",
    horizonAll: "All",
    prices: "Prices",
    incl: "Incl. tax",
    excl: "Excl. tax",
    noWindow: "No contiguous block found",
    view: "View",
    hours: "Hours",
    quarters: "Quarters",
    viewDesc: "Show prices per quarter or per hour. Electricity is always billed per quarter.",
    decimals: "Decimals (cents)",
    decimalsDesc: "Digits after the decimal point, to compare prices more precisely.",
    tax: "Energy tax",
    taxDesc: "Show prices with or without energy tax. Only applies to the price chart.",
    remaining: "Remaining hours",
    remainingDesc: "Show the number of hours from now, e.g. for setting a washing machine or dryer delay.",
    horizonDesc: "Only search for the cheapest block within this period.",
    hourShort: "h",
  },
};

// ---------------------------------------------------------------------------
// Pure data helpers (exported for tests)
// ---------------------------------------------------------------------------

const START_KEYS = ["start_date", "start", "start_time", "starts_at", "startsAt", "from", "time", "datetime"];
const END_KEYS = ["end_date", "end", "end_time", "ends_at", "endsAt", "till", "to"];
const VALUE_KEYS = ["value", "price", "total", "price_ct", "electricity_price", "tariff"];

function firstKey(obj, keys) {
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return k;
  return null;
}

function toMs(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/**
 * Normalize a forecast list into [{s, e, p, px}] sorted by start, prices in cents.
 * `p` = price incl. tax, `px` = excl. tax (or null). `factor` overrides the automatic
 * unit conversion (raw value × factor = cents).
 */
export function normalizeForecast(items, factor = null) {
  if (!Array.isArray(items) || !items.length) return [];
  const out = [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const sk = firstKey(it, START_KEYS);
    if (!sk) continue;
    const s = toMs(it[sk]);
    if (s === null) continue;
    const ek = firstKey(it, END_KEYS);
    let e = ek ? toMs(it[ek]) : null;
    let raw = null;
    let rawEx = null;
    let f = factor;
    if (it.price_tax_included && it.price_tax_included.amount !== undefined) {
      // Zonneplan ONE quarter-hourly: amounts in 1e-7 EUR.
      raw = Number(it.price_tax_included.amount);
      rawEx = it.price_tax_excluded ? Number(it.price_tax_excluded.amount) : null;
      if (f === null) f = 1e-5;
    } else if (it.electricity_price !== undefined) {
      // Zonneplan ONE hourly: amounts in 1e-7 EUR.
      raw = Number(it.electricity_price);
      rawEx = it.electricity_price_excl_tax !== undefined ? Number(it.electricity_price_excl_tax) : null;
      if (f === null) f = 1e-5;
    } else {
      const vk = firstKey(it, VALUE_KEYS);
      if (!vk) continue;
      raw = Number(it[vk]);
    }
    if (!Number.isFinite(raw)) continue;
    if (f === null) f = autoFactor(raw);
    out.push({ s, e, p: raw * f, px: rawEx !== null && Number.isFinite(rawEx) ? rawEx * f : null });
  }
  out.sort((a, b) => a.s - b.s);
  // Fill missing ends from the next start (or the typical slot length) and drop duplicates.
  const dedup = [];
  for (const sl of out) {
    if (dedup.length && dedup[dedup.length - 1].s === sl.s) continue;
    dedup.push(sl);
  }
  const typical = dedup.length > 1 ? dedup[1].s - dedup[0].s : HOUR;
  dedup.forEach((sl, i) => {
    if (sl.e === null || sl.e <= sl.s) sl.e = i + 1 < dedup.length ? dedup[i + 1].s : sl.s + typical;
  });
  return dedup;
}

// Values below ~10 are assumed to be EUR/kWh, otherwise already cents.
function autoFactor(v) {
  return Math.abs(v) < 10 ? 100 : 1;
}

/** Pull a forecast list out of an entity's attributes. */
export function forecastFromAttributes(attrs, attribute) {
  if (!attrs) return [];
  if (attribute) {
    const v = attrs[attribute];
    return Array.isArray(v) ? v : [];
  }
  if (Array.isArray(attrs.forecast)) return attrs.forecast;
  if (Array.isArray(attrs.raw_today)) return [...attrs.raw_today, ...(Array.isArray(attrs.raw_tomorrow) ? attrs.raw_tomorrow : [])];
  for (const k of ["prices", "prices_today", "data"]) if (Array.isArray(attrs[k])) return attrs[k];
  if (Array.isArray(attrs.today)) return [...attrs.today, ...(Array.isArray(attrs.tomorrow) ? attrs.tomorrow : [])];
  return [];
}

/**
 * Cheapest contiguous block of `hours` starting at or after the slot containing `now`
 * and ending no later than `until` (ms, optional). Average is duration-weighted.
 */
export function cheapestWindow(slots, hours, now, until = Infinity, key = "p") {
  const need = hours * HOUR;
  let best = null;
  const first = slots.findIndex((sl) => sl.e > now);
  if (first < 0) return null;
  for (let i = first; i < slots.length; i++) {
    let dur = 0;
    let sum = 0;
    let j = i;
    let prevEnd = slots[i].s;
    while (j < slots.length && dur < need) {
      const sl = slots[j];
      if (sl.s !== prevEnd) break; // gap in data
      const d = Math.min(sl.e - sl.s, need - dur);
      sum += (sl[key] ?? sl.p) * d;
      dur += d;
      prevEnd = sl.e;
      j++;
    }
    if (dur < need) continue;
    const end = slots[i].s + need;
    if (end > until) break;
    const avg = sum / need;
    if (!best || avg < best.avg - 1e-9) best = { start: slots[i].s, end, avg };
  }
  return best;
}

/** Average slots into local clock hours (duration-weighted); partial hours keep their real span. */
export function aggregateHourly(slots) {
  const out = [];
  let cur = null;
  for (const sl of slots) {
    const h = new Date(sl.s);
    h.setMinutes(0, 0, 0);
    const hs = h.getTime();
    if (!cur || cur.h !== hs || cur.e !== sl.s) {
      if (cur) out.push(cur);
      cur = { h: hs, s: sl.s, e: sl.s, sum: 0, sumx: 0, dur: 0, hasx: true };
    }
    const d = sl.e - sl.s;
    cur.sum += sl.p * d;
    if (sl.px === null || sl.px === undefined) cur.hasx = false;
    else cur.sumx += sl.px * d;
    cur.dur += d;
    cur.e = sl.e;
  }
  if (cur) out.push(cur);
  return out.map((c) => ({ s: c.s, e: c.e, p: c.sum / c.dur, px: c.hasx ? c.sumx / c.dur : null }));
}

export function niceStep(range) {
  for (const s of [1, 2, 5, 10, 20, 25, 50, 100, 200, 500]) if (range / s <= 4) return s;
  return 1000;
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

const GREEN_DARK = "#2f9e44";
const GREEN = "#40b25a";
const GREEN_LIGHT = "#8fdc9b";
const GREY_LINE = "#c4c4c4";

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function hhmm(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

if (typeof customElements !== "undefined" && !customElements.get("zonneplan-price-card")) {
  class ZonneplanPriceCard extends HTMLElement {
    static getStubConfig(hass) {
      const ids = Object.keys(hass?.states || {});
      const entity =
        ids.find((e) => e.includes("quarter_hourly_electricity_tariff")) ||
        ids.find((e) => e.startsWith("sensor.zonneplan_current_electricity_tariff")) ||
        "";
      const gas = ids.find((e) => e.startsWith("sensor.zonneplan_current_gas_tariff")) || "";
      return { entity, ...(gas ? { gas_entity: gas } : {}) };
    }

    static getConfigForm() {
      return {
        schema: [
          { name: "entity", required: true, selector: { entity: { domain: "sensor" } } },
          { name: "gas_entity", selector: { entity: { domain: "sensor" } } },
          { name: "title", selector: { text: {} } },
          {
            type: "grid",
            name: "",
            schema: [
              { name: "hours_past", selector: { number: { min: 0, max: 12, step: 0.25, mode: "box" } } },
              { name: "height", selector: { number: { min: 140, max: 500, step: 10, mode: "box", unit_of_measurement: "px" } } },
            ],
          },
          {
            name: "durations",
            selector: { select: { multiple: true, custom_value: true, options: ["1", "2", "3", "4", "5", "6", "8"] } },
          },
          { name: "forecast_attribute", selector: { text: {} } },
          { name: "price_factor", selector: { number: { mode: "box", step: "any" } } },
          { name: "show_selector", selector: { boolean: {} } },
          {
            type: "grid",
            name: "",
            schema: [
              { name: "view", selector: { select: { mode: "dropdown", options: ["quarter", "hour"] } } },
              { name: "decimals", selector: { number: { min: 0, max: 2, step: 1, mode: "box" } } },
              { name: "line_width", selector: { number: { min: 1, max: 4, step: 0.25, mode: "box", unit_of_measurement: "px" } } },
            ],
          },
        ],
        computeLabel: (s) =>
          ({
            entity: "Price entity (with forecast attribute)",
            gas_entity: "Gas price entity (optional)",
            title: "Title",
            hours_past: "Hours of history to show",
            height: "Chart height",
            durations: "Cheapest-block durations (hours)",
            forecast_attribute: "Forecast attribute (auto-detected if empty)",
            price_factor: "Raw value × factor = cents (auto if empty)",
            show_selector: "Show cheapest-block selector",
            view: "Default view (quarter / hour)",
            decimals: "Default decimals",
            line_width: "Line width",
          })[s.name],
      };
    }

    setConfig(config) {
      if (!config || !config.entity) throw new Error("entity is required");
      this._config = {
        hours_past: 1,
        height: 260,
        durations: [1, 2, 3, 4, 6],
        show_selector: true,
        ...config,
      };
      this._config.durations = (this._config.durations || [])
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0)
        .sort((a, b) => a - b);
      this._mode = 0; // 0 = all, otherwise hours
      this._prefs = this._loadPrefs();
      this._build();
    }

    getCardSize() {
      return Math.ceil(((this._config?.height || 260) + 140) / 50);
    }

    getGridOptions() {
      return { columns: 12, min_columns: 6, rows: "auto" };
    }

    set hass(hass) {
      const prev = this._hass;
      this._hass = hass;
      const c = this._config;
      if (
        !prev ||
        prev.states[c.entity] !== hass.states[c.entity] ||
        (c.gas_entity && prev.states[c.gas_entity] !== hass.states[c.gas_entity]) ||
        prev.language !== hass.language
      ) {
        this._slots = null;
        this._render();
      }
    }

    connectedCallback() {
      clearInterval(this._tick);
      this._tick = setInterval(() => this._render(), 60000);
      if (!this._ro && typeof ResizeObserver !== "undefined") {
        this._ro = new ResizeObserver(() => {
          const w = this._chartEl?.clientWidth || 0;
          if (w && w !== this._width) {
            this._width = w;
            this._renderChart();
          }
        });
      }
      if (this._ro && this._chartEl) this._ro.observe(this._chartEl);
    }

    disconnectedCallback() {
      clearInterval(this._tick);
      if (this._ro) this._ro.disconnect();
    }

    // ---- prefs (per card, per browser) --------------------------------------
    _prefsKey() {
      return `zonneplan-price-card:${this._config.entity}`;
    }
    _loadPrefs() {
      // Card config gives the defaults; what the viewer picks in the settings panel wins.
      const defaults = {
        horizon: 0,
        tax: "incl",
        view: this._config.view === "hour" ? "hour" : "quarter",
        decimals: Math.min(2, Math.max(0, Number(this._config.decimals ?? 0) || 0)),
        remaining: false,
      };
      try {
        return { ...defaults, ...JSON.parse(localStorage.getItem(this._prefsKey()) || "{}") };
      } catch (e) {
        return defaults;
      }
    }
    _savePrefs() {
      try {
        localStorage.setItem(this._prefsKey(), JSON.stringify(this._prefs));
      } catch (e) {
        /* storage unavailable: prefs last for this page view only */
      }
    }

    _t(k) {
      const lang = (this._hass?.language || "en").slice(0, 2);
      return (STRINGS[lang] || STRINGS.en)[k];
    }

    // ---- DOM skeleton --------------------------------------------------------
    _build() {
      if (!this.shadowRoot) this.attachShadow({ mode: "open" });
      this.shadowRoot.innerHTML = `
        <style>
          :host { display: block; }
          ha-card { padding: 16px 16px 14px; overflow: hidden; }
          .head { display: flex; align-items: center; gap: 8px; }
          .title { flex: 1; font-size: 1.25rem; font-weight: 500; color: var(--primary-text-color); min-width: 0;
                   white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
          .chip { display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 16px;
                  background: rgba(127,127,127,.12); color: var(--primary-text-color); font-size: 1rem;
                  font-weight: 500; cursor: pointer; white-space: nowrap; }
          .chip ha-icon { --mdc-icon-size: 20px; }
          .chip.el ha-icon { color: ${GREEN}; }
          .chip.gas ha-icon { color: #8fb4e3; }
          .chart { position: relative; margin-top: 8px; touch-action: pan-y; user-select: none; -webkit-user-select: none;
                   cursor: crosshair; }
          .chart svg { display: block; overflow: visible; }
          .empty { padding: 40px 0; text-align: center; color: var(--secondary-text-color); }
          .sub { margin: 14px 0 8px; color: var(--secondary-text-color); font-size: .95rem; }
          .bar { display: flex; gap: 10px; align-items: stretch; }
          .seg { flex: 1; display: flex; background: rgba(127,127,127,.12); border-radius: 14px; padding: 4px; min-width: 0; }
          .seg button { flex: 1; min-width: 0; border: 0; background: transparent; color: var(--secondary-text-color);
                        font: inherit; font-size: 1.05rem; padding: 9px 0; border-radius: 10px; cursor: pointer; }
          .seg button.on { background: var(--zpc-seg-on); color: var(--primary-text-color);
                           box-shadow: 0 1px 3px rgba(0,0,0,.12); }
          .cfg { border: 0; border-radius: 14px; background: rgba(127,127,127,.12); color: var(--primary-text-color);
                 width: 52px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
          .cfg.on { background: rgba(64,178,90,.2); }
          .panel { margin-top: 12px; display: grid; gap: 6px; color: var(--primary-text-color); }
          .box { background: rgba(127,127,127,.08); border-radius: 16px; padding: 14px 16px; }
          .srow { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 1rem; }
          .desc { color: var(--secondary-text-color); font-size: .85rem; line-height: 1.35; padding: 0 4px 10px; }
          .views { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
          .vopt { display: grid; gap: 8px; justify-items: center; background: none; border: 0; padding: 0; font: inherit;
                  color: var(--primary-text-color); cursor: pointer; }
          .vopt .pv { color: var(--primary-text-color); width: 100%; aspect-ratio: 16 / 10; border-radius: 12px; background: rgba(127,127,127,.1);
                      border: 2px solid transparent; box-sizing: border-box; display: flex; }
          .vopt.on .pv { border-color: ${GREEN}; background: transparent; }
          .vopt .pv svg { width: 100%; height: 100%; }
          .radio { display: inline-flex; align-items: center; gap: 8px; color: var(--secondary-text-color); }
          .vopt.on .radio { color: var(--primary-text-color); }
          .radio i { width: 16px; height: 16px; border-radius: 50%; border: 2px solid var(--secondary-text-color);
                     box-sizing: border-box; display: inline-block; }
          .vopt.on .radio i { border-color: ${GREEN_DARK}; background: radial-gradient(${GREEN_DARK} 45%, transparent 50%); }
          .dots { display: flex; gap: 6px; }
          .dot { width: 32px; height: 32px; border-radius: 50%; border: 0; background: rgba(127,127,127,.14);
                 color: var(--secondary-text-color); font: inherit; cursor: pointer; }
          .dot.on { background: #6fd27f; color: #10301a; }
          .sw { width: 50px; height: 30px; border-radius: 15px; border: 0; padding: 0; position: relative; cursor: pointer;
                background: rgba(127,127,127,.3); transition: background .15s; flex: none; }
          .sw::after { content: ""; position: absolute; top: 3px; left: 3px; width: 24px; height: 24px; border-radius: 50%;
                       background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25); transition: left .15s; }
          .sw.on { background: #6fd27f; }
          .sw.on::after { left: 23px; }
          .srow.wrap { flex-wrap: wrap; }
          .pills { display: flex; gap: 6px; flex-wrap: wrap; }
          .pill { border: 0; background: rgba(127,127,127,.14); color: var(--secondary-text-color);
                  border-radius: 999px; padding: 6px 12px; font: inherit; font-size: .9rem; cursor: pointer; }
          .pill.on { background: #6fd27f; color: #10301a; }
          .hidden { display: none !important; }
          ha-card { --zpc-tip-bg: #222; --zpc-tip-fg: #fff; --zpc-seg-on: var(--card-background-color, #fff); }
          ha-card.dark { --zpc-tip-bg: #e9ecea; --zpc-tip-fg: #111; --zpc-seg-on: rgba(255,255,255,.16); }
        </style>
        <ha-card>
          <div class="head">
            <div class="title"></div>
            <div class="chip el"><ha-icon icon="mdi:lightning-bolt"></ha-icon><span></span></div>
            <div class="chip gas hidden"><ha-icon icon="mdi:fire"></ha-icon><span></span></div>
          </div>
          <div class="chart"></div>
          <div class="selector">
            <div class="sub"></div>
            <div class="bar">
              <div class="seg"></div>
              <button class="cfg" aria-label="settings"><ha-icon icon="mdi:tune-variant"></ha-icon></button>
            </div>
            <div class="panel hidden"></div>
          </div>
        </ha-card>`;
      const r = this.shadowRoot;
      this._chartEl = r.querySelector(".chart");
      if (this._ro) {
        this._ro.disconnect();
        this._ro.observe(this._chartEl);
      }
      r.querySelector(".chip.el").addEventListener("click", () => this._moreInfo(this._config.entity));
      r.querySelector(".chip.gas").addEventListener("click", () => this._moreInfo(this._config.gas_entity));
      r.querySelector(".cfg").addEventListener("click", () => {
        this._panelOpen = !this._panelOpen;
        this._renderControls();
      });
      this._bindPointer();
    }

    _moreInfo(entityId) {
      if (!entityId) return;
      this.dispatchEvent(new CustomEvent("hass-more-info", { detail: { entityId }, bubbles: true, composed: true }));
    }

    _bindPointer() {
      const el = this._chartEl;
      const pos = (ev) => {
        const rect = el.getBoundingClientRect();
        return ev.clientX - rect.left;
      };
      el.addEventListener("pointerdown", (ev) => {
        this._dragging = true;
        try {
          el.setPointerCapture(ev.pointerId);
        } catch (e) {
          /* not capturable: fine */
        }
        this._scrubX = pos(ev);
        this._renderChart();
      });
      el.addEventListener("pointermove", (ev) => {
        if (ev.pointerType !== "mouse" && !this._dragging) return;
        this._scrubX = pos(ev);
        this._renderChart();
      });
      const end = (ev) => {
        this._dragging = false;
        if (ev.pointerType === "mouse" && ev.type === "pointerup") return;
        this._scrubX = null;
        this._renderChart();
      };
      el.addEventListener("pointerup", end);
      el.addEventListener("pointercancel", end);
      el.addEventListener("pointerleave", (ev) => {
        if (this._dragging) return;
        this._scrubX = null;
        this._renderChart();
      });
    }

    // ---- data ----------------------------------------------------------------
    _data() {
      if (this._slots) return this._slots;
      const st = this._hass?.states[this._config.entity];
      if (!st) return (this._slots = []);
      const f = this._config.price_factor;
      const raw = forecastFromAttributes(st.attributes, this._config.forecast_attribute);
      this._slots = normalizeForecast(raw, f === undefined || f === null || f === "" ? null : Number(f));
      this._hasExcl = this._slots.some((s) => s.px !== null);
      return this._slots;
    }

    _key() {
      return this._prefs.tax === "excl" && this._hasExcl ? "px" : "p";
    }

    _fmt(ct) {
      return `${ct.toFixed(this._prefs.decimals)} ct`;
    }

    // ---- render --------------------------------------------------------------
    _render() {
      if (!this._hass || !this._config || !this.shadowRoot) return;
      const r = this.shadowRoot;
      r.querySelector("ha-card").classList.toggle("dark", !!this._hass.themes?.darkMode);
      r.querySelector(".title").textContent = this._config.title ?? this._t("title");
      const slots = this._data();
      const now = Date.now();
      const key = this._key();
      const cur = slots.find((s) => s.s <= now && now < s.e);
      const st = this._hass.states[this._config.entity];
      let curCt = cur ? cur[key] ?? cur.p : null;
      if (curCt === null && st && !Number.isNaN(Number(st.state))) curCt = Number(st.state) * autoFactor(Number(st.state));
      r.querySelector(".chip.el span").textContent = curCt === null ? "—" : this._fmt(curCt);
      const gasChip = r.querySelector(".chip.gas");
      const gas = this._config.gas_entity && this._hass.states[this._config.gas_entity];
      gasChip.classList.toggle("hidden", !gas);
      if (gas) {
        const v = Number(gas.state);
        gasChip.querySelector("span").textContent = Number.isFinite(v) ? `${(v * autoFactor(v)).toFixed(0)} ct` : "—";
      }
      this._renderControls();
      this._renderChart();
    }

    _renderControls() {
      const r = this.shadowRoot;
      const c = this._config;
      r.querySelector(".selector").classList.toggle("hidden", !c.show_selector || !c.durations.length);
      r.querySelector(".sub").textContent = this._t("find");
      const seg = r.querySelector(".seg");
      const opts = [0, ...c.durations];
      seg.innerHTML = opts
        .map((h) => `<button data-h="${h}" class="${h === this._mode ? "on" : ""}">${h === 0 ? esc(this._t("all")) : h}</button>`)
        .join("");
      seg.querySelectorAll("button").forEach((b) =>
        b.addEventListener("click", () => {
          this._mode = Number(b.dataset.h);
          this._renderControls();
          this._renderChart();
        })
      );
      r.querySelector(".cfg").classList.toggle("on", !!this._panelOpen);
      const panel = r.querySelector(".panel");
      panel.classList.toggle("hidden", !this._panelOpen);
      if (!this._panelOpen) return;
      const t = (k) => esc(this._t(k));
      const pv = (bars) =>
        bars
          ? `<svg viewBox="0 0 160 100"><g fill="currentColor" opacity=".28">${[40, 38, 36, 42, 50, 52, 40, 30, 22, 28, 50, 76]
              .map((h, i) => `<rect x="${16 + i * 11}" y="${84 - h}" width="6" height="${h}" rx="1"/>`)
              .join("")}</g><g stroke="currentColor" opacity=".15"><line x1="14" x2="146" y1="18" y2="18"/><line x1="14" x2="146" y1="51" y2="51"/><line x1="14" x2="146" y1="84" y2="84"/></g></svg>`
          : `<svg viewBox="0 0 160 100"><g stroke="currentColor" opacity=".15"><line x1="14" x2="146" y1="18" y2="18"/><line x1="14" x2="146" y1="51" y2="51"/><line x1="14" x2="146" y1="84" y2="84"/></g>
             <path d="M14,58H20V62H26V58H32V60H38V56H44V58H50V52H58V44H64V48H72V46H78V52H84V58H90V64H96V70H104V76H110V72H116V66H124V54H130V40H136V30H142V22H146" fill="none" stroke="${GREEN}" stroke-width="2"/></svg>`;
      const sw = (key, on) => `<button class="sw ${on ? "on" : ""}" data-sw="${key}" role="switch" aria-checked="${on}"></button>`;
      let html = `
        <div class="box"><div class="views">
          <button class="vopt ${this._prefs.view === "hour" ? "on" : ""}" data-view="hour"><span class="pv">${pv(true)}</span><span class="radio"><i></i>${t("hours")}</span></button>
          <button class="vopt ${this._prefs.view !== "hour" ? "on" : ""}" data-view="quarter"><span class="pv">${pv(false)}</span><span class="radio"><i></i>${t("quarters")}</span></button>
        </div></div>
        <div class="desc">${t("viewDesc")}</div>
        <div class="box srow"><span>${t("decimals")}</span><span class="dots">${[0, 1, 2]
          .map((d) => `<button class="dot ${this._prefs.decimals === d ? "on" : ""}" data-dec="${d}">${d}</button>`)
          .join("")}</span></div>
        <div class="desc">${t("decimalsDesc")}</div>`;
      if (this._hasExcl) {
        html += `<div class="box srow"><span>${t("tax")}</span>${sw("tax", this._prefs.tax !== "excl")}</div>
          <div class="desc">${t("taxDesc")}</div>`;
      }
      html += `<div class="box srow"><span>${t("remaining")}</span>${sw("remaining", !!this._prefs.remaining)}</div>
        <div class="desc">${t("remainingDesc")}</div>
        <div class="box srow wrap"><span>${t("horizon")}</span><span class="pills">${[0, 6, 12, 24]
          .map(
            (h) =>
              `<button class="pill ${this._prefs.horizon === h ? "on" : ""}" data-hz="${h}">${h === 0 ? t("horizonAll") : `${h}${t("hourShort")}`}</button>`
          )
          .join("")}</span></div>
        <div class="desc">${t("horizonDesc")}</div>`;
      panel.innerHTML = html;
      const set = (patch) => {
        Object.assign(this._prefs, patch);
        this._savePrefs();
        this._render();
      };
      panel.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => set({ view: b.dataset.view })));
      panel.querySelectorAll("[data-dec]").forEach((b) => b.addEventListener("click", () => set({ decimals: Number(b.dataset.dec) })));
      panel.querySelectorAll("[data-hz]").forEach((b) => b.addEventListener("click", () => set({ horizon: Number(b.dataset.hz) })));
      panel.querySelectorAll("[data-sw]").forEach((b) =>
        b.addEventListener("click", () =>
          b.dataset.sw === "tax"
            ? set({ tax: this._prefs.tax === "excl" ? "incl" : "excl" })
            : set({ remaining: !this._prefs.remaining })
        )
      );
    }

    _renderChart() {
      const el = this._chartEl;
      if (!el || !this._hass) return;
      const bars = this._prefs.view === "hour";
      const slots = bars ? aggregateHourly(this._data()) : this._data();
      const W = el.clientWidth || this._width || 360;
      this._width = W;
      const H = Number(this._config.height) || 260;
      const now = Date.now();
      const key = this._key();
      const t0 = now - Number(this._config.hours_past ?? 1) * HOUR;
      const vis = slots.filter((s) => s.e > t0);
      if (!vis.length) {
        el.innerHTML = `<div class="empty">${esc(this._t("noData"))}</div>`;
        return;
      }
      const price = (s) => s[key] ?? s.p;
      const xStart = Math.max(t0, vis[0].s);
      const xEnd = vis[vis.length - 1].e;

      // Geometry
      const padL = 34;
      const padR = 8;
      const padT = 46;
      const padB = 30;
      const pw = Math.max(50, W - padL - padR);
      const ph = Math.max(40, H - padT - padB);
      const vals = vis.map(price);
      const vmax = Math.max(...vals);
      const vmin = Math.min(...vals);
      const step = niceStep(Math.max(vmax, 0) - Math.min(vmin, 0) || 1);
      const yLo = Math.min(0, Math.floor(vmin / step) * step);
      const yHi = Math.max(step, vmax + (vmax - yLo) * 0.06);
      // Snap to the device-pixel grid: the step line is all horizontal/vertical segments, and
      // fractional coordinates are what made it look soft (anti-aliased over two pixels).
      const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
      const snap = (v) => Math.round(v * dpr) / dpr;
      const X = (t) => snap(padL + ((t - xStart) / (xEnd - xStart)) * pw);
      const Y = (v) => snap(padT + (1 - (v - yLo) / (yHi - yLo)) * ph);
      const base = Y(0);
      const bottom = padT + ph;

      // Scrub position (computed early so the min/max labels can step aside).
      let scrub = null;
      if (this._scrubX !== null && this._scrubX !== undefined) {
        const sx = snap(Math.min(Math.max(this._scrubX, padL), padL + pw));
        const t = xStart + ((sx - padL) / pw) * (xEnd - xStart);
        const s = vis.find((v) => v.s <= t && t < v.e) || vis[vis.length - 1];
        const label = this._prefs.remaining
          ? `${hhmm(Math.max(s.s, xStart))} · ${this._relative(s.s, now)}`
          : hhmm(Math.max(s.s, xStart));
        const value = this._fmt(price(s));
        scrub = { sx, s, label, value, box: this._tipBox(sx, label, W, value) };
      }

      const sel = this._mode
        ? cheapestWindow(slots, this._mode, now, this._prefs.horizon ? now + this._prefs.horizon * HOUR : Infinity, key)
        : null;

      // Step path helpers
      const stepPath = (list) => {
        let d = "";
        list.forEach((s, i) => {
          const x1 = X(Math.max(s.s, xStart));
          const x2 = X(s.e);
          const y = Y(price(s));
          d += i === 0 ? `M${x1},${y}` : `L${x1},${y}`;
          d += `L${x2},${y}`;
        });
        return d;
      };
      const areaPath = (list) => {
        if (!list.length) return "";
        const x1 = X(Math.max(list[0].s, xStart));
        const x2 = X(list[list.length - 1].e);
        return `${stepPath(list)}L${x2},${base}L${x1},${base}Z`;
      };
      // Hour view: one rounded bar per slot, coloured per slot.
      const barRects = (list, color) =>
        list
          .map((sl) => {
            const x1 = X(Math.max(sl.s, xStart));
            const x2 = X(sl.e);
            const gap = Math.min(3, (x2 - x1) * 0.3);
            const y = Y(price(sl));
            const top = Math.min(y, base);
            const h = Math.max(1, Math.abs(base - y));
            return `<rect x="${x1 + gap / 2}" y="${top}" width="${Math.max(1, x2 - x1 - gap)}" height="${h}" rx="${Math.min(2, (x2 - x1 - gap) / 2)}" fill="${color(sl)}"/>`;
          })
          .join("");
      const level = (sl) => this._levelColor((price(sl) - vmin) / (vmax - vmin || 1));
      const clipSlots = (list, a, b) =>
        list.filter((s) => s.e > a && s.s < b).map((s) => ({ ...s, s: Math.max(s.s, a), e: Math.min(s.e, b) }));

      const past = clipSlots(vis, xStart, now);
      const future = clipSlots(vis, now, xEnd);

      let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="zpc-line" gradientUnits="userSpaceOnUse" x1="0" y1="${padT}" x2="0" y2="${bottom}">
            <stop offset="0" stop-color="${GREEN_DARK}"/><stop offset="1" stop-color="${GREEN_LIGHT}"/>
          </linearGradient>
          <linearGradient id="zpc-fill" gradientUnits="userSpaceOnUse" x1="0" y1="${padT}" x2="0" y2="${bottom}">
            <stop offset="0" stop-color="${GREEN}" stop-opacity=".18"/><stop offset="1" stop-color="${GREEN}" stop-opacity=".02"/>
          </linearGradient>
        </defs>`;

      // Grid + y labels
      const gridColor = "var(--divider-color, rgba(127,127,127,.25))";
      const textColor = "var(--secondary-text-color, #777)";
      for (let v = yLo; v <= yHi + 1e-9; v += step) {
        const y = Y(v) + (dpr === 1 ? 0.5 : 0);
        svg += `<line x1="${padL - 6}" x2="${W - padR}" y1="${y}" y2="${y}" stroke="${gridColor}" stroke-width="1"/>`;
        svg += `<text x="${padL - 10}" y="${y + 4}" text-anchor="end" font-size="12" fill="${textColor}">${v}</text>`;
      }

      // Day separators
      const d0 = new Date(xStart);
      d0.setHours(24, 0, 0, 0);
      const today = new Date(now);
      today.setHours(0, 0, 0, 0);
      const lang = this._hass.language || "en";
      for (let t = d0.getTime(); t < xEnd; ) {
        const x = X(t);
        const dayDiff = Math.round((t - today.getTime()) / (24 * HOUR));
        const label =
          dayDiff === 1 ? this._t("tomorrow") : new Date(t).toLocaleDateString(lang, { weekday: "short" }).replace(".", "");
        svg += `<line x1="${x}" x2="${x}" y1="${padT - 8}" y2="${bottom}" stroke="${gridColor}" stroke-width="1"/>`;
        if (x + 60 < W) svg += `<text x="${x + 6}" y="${padT + 6}" font-size="12" fill="${textColor}" opacity=".8">${esc(label)}</text>`;
        const nd = new Date(t);
        nd.setDate(nd.getDate() + 1);
        t = nd.getTime();
      }

      // X axis ticks/labels
      const pxPerHour = pw / ((xEnd - xStart) / HOUR);
      const labelEvery = pxPerHour * 3 >= 30 ? 3 : pxPerHour * 6 >= 30 ? 6 : 12;
      if (this._prefs.remaining) {
        // Hours from now, for delay timers: "nu", +3, +6, ...
        for (let k = 0, t = now; t <= xEnd; k++, t += HOUR) {
          const x = X(t);
          const major = k % labelEvery === 0;
          if (!major && pxPerHour < 6) continue;
          svg += `<line x1="${x}" x2="${x}" y1="${bottom + 4}" y2="${bottom + (major ? 10 : 8)}" stroke="${textColor}" stroke-width="1" opacity="${major ? 0.9 : 0.5}"/>`;
          if (major) svg += `<text x="${x}" y="${bottom + 25}" text-anchor="middle" font-size="12" fill="${textColor}">${k === 0 ? esc(this._t("now")) : `+${k}`}</text>`;
        }
      }
      const h0 = new Date(xStart);
      h0.setMinutes(0, 0, 0);
      if (h0.getTime() < xStart) h0.setHours(h0.getHours() + 1);
      for (let t = this._prefs.remaining ? Infinity : h0.getTime(); t <= xEnd; t += HOUR) {
        const hr = new Date(t).getHours();
        const x = X(t);
        const major = hr % labelEvery === 0;
        if (!major && pxPerHour < 6) continue;
        svg += `<line x1="${x}" x2="${x}" y1="${bottom + 4}" y2="${bottom + (major ? 10 : 8)}" stroke="${textColor}" stroke-width="1" opacity="${major ? 0.9 : 0.5}"/>`;
        if (major) svg += `<text x="${x}" y="${bottom + 25}" text-anchor="middle" font-size="12" fill="${textColor}">${pad2(hr)}</text>`;
      }
      svg += `<line x1="${padL - 6}" x2="${W - padR}" y1="${bottom}" y2="${bottom}" stroke="${gridColor}"/>`;

      // Series
      const lineW = Number(this._config.line_width) || 2;
      const ln = `fill="none" stroke-width="${lineW}" stroke-linejoin="miter" stroke-linecap="butt"`;
      if (sel) {
        // Everything grey, selected block highlighted.
        const blk = clipSlots(vis, sel.start, sel.end);
        const bx1 = X(sel.start);
        const bx2 = X(sel.end);
        if (bars) {
          svg += barRects(vis.filter((v) => v.e <= sel.start || v.s >= sel.end), () => GREY_LINE);
          svg += barRects(blk, () => GREEN);
        } else {
          svg += `<path d="${stepPath(vis.map((v) => ({ ...v, s: Math.max(v.s, xStart) })))}" stroke="${GREY_LINE}" ${ln}/>`;
          svg += `<path d="${areaPath(blk)}" fill="url(#zpc-fill)"/>`;
          svg += `<path d="${stepPath(blk)}" stroke="${GREEN}" ${ln}/>`;
        }
        // Bracket + tooltip
        const top = Y(Math.max(...blk.map(price))) - 8;
        const tipY = Math.max(4, top - 46);
        svg += `<path d="M${bx1},${top + 8}V${top}H${bx2}V${top + 8}M${snap((bx1 + bx2) / 2)},${top}V${tipY + 30}" fill="none" stroke="${textColor}" stroke-width="1" opacity=".8"/>`;
        const rel = this._relative(sel.start, now);
        const txt = `${hhmm(sel.start)} ${this._t("to")} ${hhmm(sel.end)}${lang.startsWith("nl") ? " uur" : ""} · ${rel} · ${this._fmt(sel.avg)}`;
        svg += this._tip((bx1 + bx2) / 2, tipY, txt, W);
      } else if (this._mode) {
        svg += bars ? barRects(vis, () => GREY_LINE) : `<path d="${stepPath(vis)}" stroke="${GREY_LINE}" ${ln}/>`;
        svg += this._tip(W / 2, 4, this._t("noWindow"), W);
      } else {
        if (bars) {
          svg += barRects(vis.filter((v) => v.e <= now), () => GREY_LINE);
          svg += barRects(vis.filter((v) => v.e > now), level);
        } else {
          if (past.length) svg += `<path d="${stepPath(past)}" stroke="${GREY_LINE}" ${ln}/>`;
          if (future.length) {
            svg += `<path d="${areaPath(future)}" fill="url(#zpc-fill)"/>`;
            svg += `<path d="${stepPath(future)}" stroke="url(#zpc-line)" ${ln}/>`;
          }
        }
        // Min / max labels over the upcoming part.
        const up = vis.filter((v) => v.e > now);
        if (up.length) {
          const mx = up.reduce((a, b) => (price(b) > price(a) ? b : a));
          const mn = up.reduce((a, b) => (price(b) < price(a) ? b : a));
          const avoid = scrub ? scrub.box : null;
          svg += this._bubble(X((Math.max(mx.s, now) + mx.e) / 2), Y(price(mx)), this._fmt(price(mx)), W, avoid);
          if (mn !== mx) svg += this._bubble(X((Math.max(mn.s, now) + mn.e) / 2), Y(price(mn)), this._fmt(price(mn)), W, avoid);
        }
      }

      // Now marker
      const curSlot = vis.find((s) => s.s <= now && now < s.e);
      if (curSlot && !sel) {
        svg += `<circle cx="${X(now)}" cy="${Y(price(curSlot))}" r="5" fill="var(--card-background-color, #fff)" stroke="${GREEN_DARK}" stroke-width="2"/>`;
      }

      // Scrub
      if (scrub) {
        const { sx, s: sl } = scrub;
        const y = Y(price(sl));
        const frac = (price(sl) - vmin) / (vmax - vmin || 1);
        svg += `<line x1="${sx}" x2="${sx}" y1="${padT - 12}" y2="${bottom}" stroke="${textColor}" stroke-width="1.5" opacity=".55"/>`;
        svg += `<circle cx="${sx}" cy="${y}" r="5" fill="var(--card-background-color, #fff)" stroke="var(--primary-text-color, #111)" stroke-width="2"/>`;
        svg += this._tip(sx, 2, scrub.label, W, scrub.value, this._levelColor(frac));
      }

      svg += `</svg>`;
      el.innerHTML = svg;
      el.style.height = `${H}px`;
    }

    _levelColor(frac) {
      // light → dark green as the price rises
      const a = [143, 220, 155];
      const b = [47, 158, 68];
      const c = a.map((v, i) => Math.round(v + (b[i] - v) * Math.min(1, Math.max(0, frac))));
      return `rgb(${c.join(",")})`;
    }

    _relative(start, now) {
      const mins = Math.round((start - now) / 60000);
      if (mins <= 0) return this._t("now");
      if (mins < 60) return `+${mins} ${this._t("min")}`;
      return `+${Math.round(mins / 60)} ${this._t("hour")}`;
    }

    // Dark rounded tooltip; with `value`, renders "label ● value".
    _tipBox(cx, label, W, value = null) {
      const cw = 15 * 0.56;
      const w = label.length * cw + (value !== null ? 22 + value.length * cw : 0) + 28;
      return { x: Math.min(Math.max(cx - w / 2, 0), W - w), w };
    }

    _tip(cx, y, label, W, value = null, dot = GREEN) {
      const fs = 15;
      const cw = fs * 0.56;
      const { x, w } = this._tipBox(cx, label, W, value);
      const h = 34;
      let s = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="var(--zpc-tip-bg)" opacity=".95"/>`;
      if (value === null) {
        s += `<text x="${x + w / 2}" y="${y + h / 2 + 5}" text-anchor="middle" font-size="${fs}" fill="var(--zpc-tip-fg)">${esc(label)}</text>`;
      } else {
        const lx = x + 14;
        const dx = lx + label.length * cw + 8;
        s += `<text x="${lx}" y="${y + h / 2 + 5}" font-size="${fs}" fill="var(--zpc-tip-fg)">${esc(label)}</text>`;
        s += `<rect x="${dx}" y="${y + 9}" width="7" height="16" rx="3.5" fill="${dot}"/>`;
        s += `<text x="${dx + 14}" y="${y + h / 2 + 5}" font-size="${fs}" fill="var(--zpc-tip-fg)">${esc(value)}</text>`;
      }
      return s;
    }

    // Light green label above a point, with a stem down to it.
    _bubble(cx, py, label, W, avoid = null) {
      const fs = 14;
      const w = label.length * fs * 0.6 + 22;
      const h = 28;
      const y = Math.max(2, py - h - 16);
      const x = Math.min(Math.max(cx - w / 2, 0), W - w);
      if (avoid && y < 40 && x < avoid.x + avoid.w + 4 && avoid.x < x + w + 4) return "";
      return (
        `<line x1="${cx}" x2="${cx}" y1="${y + h}" y2="${py - 4}" stroke="var(--secondary-text-color, #888)" stroke-width="1.2" opacity=".7"/>` +
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="rgba(64,178,90,.2)"/>` +
        `<text x="${x + w / 2}" y="${y + h / 2 + 5}" text-anchor="middle" font-size="${fs}" font-weight="600" fill="var(--primary-text-color, #111)">${esc(label)}</text>`
      );
    }
  }

  customElements.define("zonneplan-price-card", ZonneplanPriceCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "zonneplan-price-card",
    name: "Zonneplan Price Card",
    description: "Dynamic energy price chart with cheapest-block finder, styled after the Zonneplan app.",
    preview: true,
    documentationURL: "https://github.com/yodax/zonneplan-price-card",
  });
  console.info(`%c ZONNEPLAN-PRICE-CARD %c v${VERSION} `, "background:#40b25a;color:#fff", "");
}
