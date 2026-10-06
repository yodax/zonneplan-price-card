# Zonneplan Price Card

A Home Assistant Lovelace card for dynamic energy prices, styled after the Zonneplan app:

- stepped price line with 15-minute resolution, darker green as the price rises
- min/max labels over the upcoming period and a marker for the current price
- **find the cheapest block**: pick 1, 2, 3, 4 or 6 hours and the card highlights the
  cheapest contiguous block, e.g. `12:30 tot 14:30 uur · +18 uur · 30 ct`
- **drag across the chart** (or hover with a mouse) to read the price of any slot
- current electricity and (optional) gas price chips that open the more-info dialog
- light and dark theme, Dutch and English labels (follows the HA language)

Made for the [Zonneplan ONE](https://github.com/fsaris/home-assistant-zonneplan-one)
integration's quarter-hourly tariff sensor, but it reads any sensor that exposes a list of
price slots (see [Data sources](#data-sources)).

## Install

### HACS (custom repository)
1. HACS → ⋮ → *Custom repositories* → add `https://github.com/yodax/zonneplan-price-card`,
   type **Dashboard**.
2. Install *Zonneplan Price Card* and reload the browser.

### Manual
Copy `zonneplan-price-card.js` to `/config/www/` and add it as a dashboard resource
(`/local/zonneplan-price-card.js`, type *JavaScript module*).

## Configuration

```yaml
type: custom:zonneplan-price-card
entity: sensor.zonneplan_current_quarter_hourly_electricity_tariff
gas_entity: sensor.zonneplan_current_gas_tariff   # optional
```

| Option | Default | Description |
|---|---|---|
| `entity` | **required** | Sensor with the price forecast in an attribute |
| `gas_entity` | — | Gas price sensor (EUR/m³) for the second chip |
| `title` | `Energieprijzen` / `Energy prices` | Card title |
| `hours_past` | `1` | Hours of history shown (greyed out) before now |
| `height` | `260` | Chart height in px |
| `durations` | `[1, 2, 3, 4, 6]` | Block lengths (hours) offered by the cheapest-block selector |
| `show_selector` | `true` | Show the cheapest-block selector |
| `decimals` | `0` | Decimals for prices in cents |
| `forecast_attribute` | auto | Attribute holding the slot list |
| `price_factor` | auto | Raw value × factor = cents. Auto: Zonneplan amounts are converted, values below 10 are treated as EUR/kWh |

The ⚙ button next to the selector limits the search to the next 6/12/24 hours and switches
between prices incl./excl. tax (when the source provides both). These choices are stored
per browser.

The card has a visual editor; all options are available there.

## Data sources

Detected automatically:

| Source | Shape |
|---|---|
| Zonneplan ONE, quarter-hourly | `forecast: [{start_date, end_date, price_tax_included: {amount}, price_tax_excluded: {amount}}]` |
| Zonneplan ONE, hourly | `forecast: [{datetime, electricity_price, electricity_price_excl_tax}]` |
| Nord Pool | `raw_today` + `raw_tomorrow: [{start, end, value}]` |
| Generic | a list of objects with a start (`start`, `start_time`, `from`, `time`, …), an optional end, and a value (`value`, `price`, `total`, …) |

Slots may be any length; the cheapest-block search uses the actual slot boundaries and
skips blocks that span a gap in the data.

## Development

No build step: the card is a single ES module. Tests cover the data parsing and the
cheapest-block search:

```sh
npm test
```

## License

MIT
