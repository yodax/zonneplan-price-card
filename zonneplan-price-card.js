// zonneplan-price-card — dynamic energy price chart for Home Assistant, styled after the
// Zonneplan app: a stepped price line with min/max labels, a "find the cheapest N hours"
// selector, and a scrub tooltip when you drag across the chart.
//
// Works with the 15-minute (and hourly) tariff forecast exposed by the Zonneplan ONE
// integration, and with generic forecast attributes ({start, end, value}-style lists,
// Nord Pool's raw_today/raw_tomorrow). See README.md for configuration.

export const VERSION = "0.1.0";

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
const GREY_LINE = "#bdbdbd";

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
      try {
        return { horizon: 0, tax: "incl", ...JSON.parse(localStorage.getItem(this._prefsKey()) || "{}") };
      } catch (e) {
        return { horizon: 0, tax: "incl" };
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
          .panel { margin-top: 10px; padding: 10px 12px; border-radius: 12px; background: rgba(127,127,127,.08);
                   display: grid; gap: 8px; font-size: .9rem; color: var(--primary-text-color); }
          .panel .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
          .panel .lbl { flex-basis: 100%; color: var(--secondary-text-color); font-size: .85rem; }
          .pill { border: 1px solid var(--divider-color, rgba(127,127,127,.3)); background: transparent; color: inherit;
                  border-radius: 999px; padding: 4px 10px; font: inherit; cursor: pointer; }
          .pill.on { background: ${GREEN}; border-color: ${GREEN}; color: #fff; }
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
      const d = Number(this._config.decimals ?? 0);
      return `${ct.toFixed(d)} ct`;
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
      const hz = [0, 6, 12, 24];
      const hzBtns = hz
        .map(
          (h) =>
            `<button class="pill ${this._prefs.horizon === h ? "on" : ""}" data-hz="${h}">${
              h === 0 ? esc(this._t("horizonAll")) : `${h} ${esc(this._t("hour"))}`
            }</button>`
        )
        .join("");
      const taxRow = this._hasExcl
        ? `<div class="row"><span class="lbl">${esc(this._t("prices"))}</span>
             <button class="pill ${this._prefs.tax !== "excl" ? "on" : ""}" data-tax="incl">${esc(this._t("incl"))}</button>
             <button class="pill ${this._prefs.tax === "excl" ? "on" : ""}" data-tax="excl">${esc(this._t("excl"))}</button></div>`
        : "";
      panel.innerHTML = `<div class="row"><span class="lbl">${esc(this._t("horizon"))}</span>${hzBtns}</div>${taxRow}`;
      panel.querySelectorAll("[data-hz]").forEach((b) =>
        b.addEventListener("click", () => {
          this._prefs.horizon = Number(b.dataset.hz);
          this._savePrefs();
          this._renderControls();
          this._renderChart();
        })
      );
      panel.querySelectorAll("[data-tax]").forEach((b) =>
        b.addEventListener("click", () => {
          this._prefs.tax = b.dataset.tax;
          this._savePrefs();
          this._render();
        })
      );
    }

    _renderChart() {
      const el = this._chartEl;
      if (!el || !this._hass) return;
      const slots = this._data();
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
      const X = (t) => padL + ((t - xStart) / (xEnd - xStart)) * pw;
      const Y = (v) => padT + (1 - (v - yLo) / (yHi - yLo)) * ph;
      const base = Y(0);
      const bottom = padT + ph;

      // Scrub position (computed early so the min/max labels can step aside).
      let scrub = null;
      if (this._scrubX !== null && this._scrubX !== undefined) {
        const sx = Math.min(Math.max(this._scrubX, padL), padL + pw);
        const t = xStart + ((sx - padL) / pw) * (xEnd - xStart);
        const s = vis.find((v) => v.s <= t && t < v.e) || vis[vis.length - 1];
        const label = hhmm(Math.max(s.s, xStart));
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
          d += i === 0 ? `M${x1.toFixed(1)},${y.toFixed(1)}` : `L${x1.toFixed(1)},${y.toFixed(1)}`;
          d += `L${x2.toFixed(1)},${y.toFixed(1)}`;
        });
        return d;
      };
      const areaPath = (list) => {
        if (!list.length) return "";
        const x1 = X(Math.max(list[0].s, xStart));
        const x2 = X(list[list.length - 1].e);
        return `${stepPath(list)}L${x2.toFixed(1)},${base.toFixed(1)}L${x1.toFixed(1)},${base.toFixed(1)}Z`;
      };
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
            <stop offset="0" stop-color="${GREEN}" stop-opacity=".22"/><stop offset="1" stop-color="${GREEN}" stop-opacity=".03"/>
          </linearGradient>
        </defs>`;

      // Grid + y labels
      const gridColor = "var(--divider-color, rgba(127,127,127,.25))";
      const textColor = "var(--secondary-text-color, #777)";
      for (let v = yLo; v <= yHi + 1e-9; v += step) {
        const y = Y(v);
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
      const h0 = new Date(xStart);
      h0.setMinutes(0, 0, 0);
      if (h0.getTime() < xStart) h0.setHours(h0.getHours() + 1);
      for (let t = h0.getTime(); t <= xEnd; t += HOUR) {
        const hr = new Date(t).getHours();
        const x = X(t);
        const major = hr % labelEvery === 0;
        if (!major && pxPerHour < 6) continue;
        svg += `<line x1="${x}" x2="${x}" y1="${bottom + 4}" y2="${bottom + (major ? 10 : 8)}" stroke="${textColor}" stroke-width="1" opacity="${major ? 0.9 : 0.5}"/>`;
        if (major) svg += `<text x="${x}" y="${bottom + 25}" text-anchor="middle" font-size="12" fill="${textColor}">${pad2(hr)}</text>`;
      }
      svg += `<line x1="${padL - 6}" x2="${W - padR}" y1="${bottom}" y2="${bottom}" stroke="${gridColor}"/>`;

      // Series
      const lineW = 2.2;
      if (sel) {
        // Everything grey, selected block highlighted.
        svg += `<path d="${stepPath(vis.map((s) => ({ ...s, s: Math.max(s.s, xStart) })))}" fill="none" stroke="${GREY_LINE}" stroke-width="${lineW}" stroke-linejoin="round"/>`;
        const blk = clipSlots(vis, sel.start, sel.end);
        const bx1 = X(sel.start);
        const bx2 = X(sel.end);
        svg += `<path d="${areaPath(blk)}" fill="url(#zpc-fill)"/>`;
        svg += `<path d="${stepPath(blk)}" fill="none" stroke="${GREEN}" stroke-width="${lineW + 0.6}" stroke-linejoin="round"/>`;
        // Bracket + tooltip
        const top = Y(Math.max(...blk.map(price))) - 8;
        const tipY = Math.max(4, top - 46);
        svg += `<path d="M${bx1},${top + 8}V${top}H${bx2}V${top + 8}M${(bx1 + bx2) / 2},${top}V${tipY + 30}" fill="none" stroke="${textColor}" stroke-width="1.2" opacity=".8"/>`;
        const rel = this._relative(sel.start, now);
        const txt = `${hhmm(sel.start)} ${this._t("to")} ${hhmm(sel.end)}${lang.startsWith("nl") ? " uur" : ""} · ${rel} · ${this._fmt(sel.avg)}`;
        svg += this._tip((bx1 + bx2) / 2, tipY, txt, W);
      } else if (this._mode) {
        svg += `<path d="${stepPath(vis)}" fill="none" stroke="${GREY_LINE}" stroke-width="${lineW}"/>`;
        svg += this._tip(W / 2, 4, this._t("noWindow"), W);
      } else {
        if (past.length) svg += `<path d="${stepPath(past)}" fill="none" stroke="${GREY_LINE}" stroke-width="${lineW}" stroke-linejoin="round"/>`;
        if (future.length) {
          svg += `<path d="${areaPath(future)}" fill="url(#zpc-fill)"/>`;
          svg += `<path d="${stepPath(future)}" fill="none" stroke="url(#zpc-line)" stroke-width="${lineW + 0.4}" stroke-linejoin="round"/>`;
        }
        // Min / max labels over the upcoming part.
        const up = vis.filter((s) => s.e > now);
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
        svg += `<circle cx="${X(now)}" cy="${Y(price(curSlot))}" r="5.5" fill="var(--card-background-color, #fff)" stroke="${GREEN_DARK}" stroke-width="2.5"/>`;
      }

      // Scrub
      if (scrub) {
        const { sx, s: sl } = scrub;
        const y = Y(price(sl));
        const frac = (price(sl) - vmin) / (vmax - vmin || 1);
        svg += `<line x1="${sx}" x2="${sx}" y1="${padT - 12}" y2="${bottom}" stroke="${textColor}" stroke-width="2" opacity=".55"/>`;
        svg += `<circle cx="${sx}" cy="${y}" r="5.5" fill="var(--card-background-color, #fff)" stroke="var(--primary-text-color, #111)" stroke-width="2.5"/>`;
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
