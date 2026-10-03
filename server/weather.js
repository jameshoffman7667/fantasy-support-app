import { cacheGet, cacheSet } from "./db.js";
import * as schedule from "./schedule.js";
import * as store from "./projectionStore.js";

/**
 * v2.8 game-day weather for outdoor stadiums, from Open-Meteo (free, no key,
 * non-commercial use). Not verified from the build sandbox (its network
 * can't reach api.open-meteo.com) — the request follows Open-Meteo's
 * documented /v1/forecast API, and every field is read defensively, so a
 * failure just means "no forecast".
 *
 * Domes get no forecast. Retractable roofs get the forecast plus "roof may
 * be closed" and are never flagged (teams close the roof in bad weather).
 * Neutral-site games (London, etc.) get no forecast unless ESPN says the
 * venue is indoors.
 *
 * Flag rule (app-wide thresholds, owner-editable): over the kickoff hour and
 * the 3 after it, sustained wind ≥ windMph or gusts ≥ gustMph, or
 * precipitation likely (chance ≥ precipProbPct with ≥ minPrecipIn in an
 * hour), or heavy (≥ heavyPrecipIn in an hour regardless of chance), or
 * snow totalling ≥ snowIn. A flag marks the player "minor" on the lineup page.
 */
// lat, lon, roof ("open" | "dome" | "retractable"). Teams keyed by the
// app's normalized abbreviations (JAC, WAS). 2026: Buffalo's new Highmark
// Stadium; Tennessee still at Nissan Stadium.
export const STADIUMS = {
  ARI: { name: "State Farm Stadium", lat: 33.5276, lon: -112.2626, roof: "retractable" },
  ATL: { name: "Mercedes-Benz Stadium", lat: 33.7554, lon: -84.4008, roof: "retractable" },
  BAL: { name: "M&T Bank Stadium", lat: 39.278, lon: -76.6227, roof: "open" },
  BUF: { name: "Highmark Stadium", lat: 42.7738, lon: -78.787, roof: "open" },
  CAR: { name: "Bank of America Stadium", lat: 35.2258, lon: -80.8528, roof: "open" },
  CHI: { name: "Soldier Field", lat: 41.8623, lon: -87.6167, roof: "open" },
  CIN: { name: "Paycor Stadium", lat: 39.0955, lon: -84.5161, roof: "open" },
  CLE: { name: "Huntington Bank Field", lat: 41.5061, lon: -81.6995, roof: "open" },
  DAL: { name: "AT&T Stadium", lat: 32.7473, lon: -97.0945, roof: "retractable" },
  DEN: { name: "Empower Field at Mile High", lat: 39.7439, lon: -105.0201, roof: "open" },
  DET: { name: "Ford Field", lat: 42.34, lon: -83.0456, roof: "dome" },
  GB: { name: "Lambeau Field", lat: 44.5013, lon: -88.0622, roof: "open" },
  HOU: { name: "NRG Stadium", lat: 29.6847, lon: -95.4107, roof: "retractable" },
  IND: { name: "Lucas Oil Stadium", lat: 39.7601, lon: -86.1639, roof: "retractable" },
  JAC: { name: "EverBank Stadium", lat: 30.3239, lon: -81.6373, roof: "open" },
  KC: { name: "GEHA Field at Arrowhead", lat: 39.0489, lon: -94.4839, roof: "open" },
  LV: { name: "Allegiant Stadium", lat: 36.0909, lon: -115.1833, roof: "dome" },
  LAC: { name: "SoFi Stadium", lat: 33.9535, lon: -118.3392, roof: "dome" },
  LAR: { name: "SoFi Stadium", lat: 33.9535, lon: -118.3392, roof: "dome" },
  MIA: { name: "Hard Rock Stadium", lat: 25.958, lon: -80.2389, roof: "open" },
  MIN: { name: "U.S. Bank Stadium", lat: 44.9737, lon: -93.2577, roof: "dome" },
  NE: { name: "Gillette Stadium", lat: 42.0909, lon: -71.2643, roof: "open" },
  NO: { name: "Caesars Superdome", lat: 29.9511, lon: -90.0812, roof: "dome" },
  NYG: { name: "MetLife Stadium", lat: 40.8135, lon: -74.0745, roof: "open" },
  NYJ: { name: "MetLife Stadium", lat: 40.8135, lon: -74.0745, roof: "open" },
  PHI: { name: "Lincoln Financial Field", lat: 39.9008, lon: -75.1675, roof: "open" },
  PIT: { name: "Acrisure Stadium", lat: 40.4468, lon: -80.0158, roof: "open" },
  SF: { name: "Levi's Stadium", lat: 37.403, lon: -121.97, roof: "open" },
  SEA: { name: "Lumen Field", lat: 47.5952, lon: -122.3316, roof: "open" },
  TB: { name: "Raymond James Stadium", lat: 27.9759, lon: -82.5033, roof: "open" },
  TEN: { name: "Nissan Stadium", lat: 36.1665, lon: -86.7713, roof: "open" },
  WAS: { name: "Northwest Stadium", lat: 38.9076, lon: -76.8645, roof: "open" },
};

export const DEFAULT_SETTINGS = { enabled: true, windMph: 15, gustMph: 25, precipProbPct: 60, minPrecipIn: 0.02, heavyPrecipIn: 0.1, snowIn: 0.1 };
export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(store.getState("weather_settings", {}) || {}) };
}
export function saveSettings(input = {}) {
  const cur = getSettings();
  const num = (v, d, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
  };
  const next = {
    enabled: input.enabled != null ? Boolean(input.enabled) : cur.enabled,
    windMph: num(input.windMph ?? cur.windMph, 15, 0, 80),
    gustMph: num(input.gustMph ?? cur.gustMph, 25, 0, 100),
    precipProbPct: num(input.precipProbPct ?? cur.precipProbPct, 60, 0, 100),
    minPrecipIn: num(input.minPrecipIn ?? cur.minPrecipIn, 0.02, 0, 2),
    heavyPrecipIn: num(input.heavyPrecipIn ?? cur.heavyPrecipIn, 0.1, 0, 5),
    snowIn: num(input.snowIn ?? cur.snowIn, 0.1, 0, 20),
  };
  store.setState("weather_settings", next);
  return next;
}

const HOURLY = ["temperature_2m", "apparent_temperature", "precipitation_probability", "precipitation", "rain", "snowfall", "wind_speed_10m", "wind_gusts_10m", "wind_direction_10m", "weather_code"];
const FORECAST_TTL_MS = 60 * 60 * 1000;

async function fetchForecast(lat, lon) {
  const key = `openmeteo:${lat},${lon}`;
  const hit = cacheGet(key);
  if (hit !== null) return hit;
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly: HOURLY.join(","),
    wind_speed_unit: "mph",
    temperature_unit: "fahrenheit",
    precipitation_unit: "inch",
    timezone: "UTC",
    past_days: "3",
    forecast_days: "16",
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  const json = await res.json();
  const h = json?.hourly || {};
  const times = (h.time || []).map((t) => Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(t) ? t : `${t}Z`));
  const hours = times.map((t, i) => {
    const o = { time: t };
    for (const k of HOURLY) o[k] = h[k]?.[i] ?? null;
    return o;
  });
  cacheSet(key, hours, FORECAST_TTL_MS);
  return hours;
}

const WMO = {
  0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 56: "Freezing drizzle", 57: "Freezing drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
  80: "Rain showers", 81: "Rain showers", 82: "Violent rain showers", 85: "Snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Thunderstorm with hail",
};
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
export const compass = (deg) => (deg == null ? null : COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16]);
function precipType(h) {
  if (h.snowfall > 0) return "snow";
  if ((h.precipitation ?? 0) > 0 || (h.rain ?? 0) > 0) return [56, 57, 66, 67].includes(h.weather_code) ? "freezing rain" : "rain";
  return null;
}
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

/**
 * Summary + flag for one game's hours. `hours` is Open-Meteo hourly rows;
 * the game window is the kickoff hour and the 3 after it.
 */
export function evaluate(hours, kickoff, roof, settings = DEFAULT_SETTINGS) {
  const start = Math.floor(kickoff / 3600e3) * 3600e3;
  const win = hours.filter((h) => h.time >= start && h.time < start + 4 * 3600e3);
  if (!win.length) return null;
  const max = (k) => Math.max(...win.map((h) => Number(h[k] ?? 0)));
  const k0 = win[0];
  const s = {
    temp: r1(k0.temperature_2m),
    feelsLike: r1(k0.apparent_temperature),
    wind: r1(max("wind_speed_10m")),
    gust: r1(max("wind_gusts_10m")),
    windDir: compass(k0.wind_direction_10m),
    precipProb: Math.round(max("precipitation_probability")),
    precipMax: Math.round(max("precipitation") * 100) / 100,
    precipTotal: Math.round(win.reduce((a, h) => a + Number(h.precipitation ?? 0), 0) * 100) / 100,
    snowTotal: Math.round(win.reduce((a, h) => a + Number(h.snowfall ?? 0), 0) * 100) / 100,
    precipType: win.map(precipType).find(Boolean) || null,
    conditions: WMO[k0.weather_code] ?? null,
  };
  const reasons = [];
  if (s.wind >= settings.windMph || s.gust >= settings.gustMph) reasons.push(`Wind ${Math.round(s.wind)} mph, gusts ${Math.round(s.gust)}`);
  if (s.snowTotal >= settings.snowIn) reasons.push(`Snow ~${s.snowTotal}" during the game`);
  else if (s.precipMax >= settings.heavyPrecipIn) reasons.push(`Heavy ${s.precipType || "precipitation"} (${s.precipMax}"/hr)`);
  else if (s.precipProb >= settings.precipProbPct && s.precipMax >= settings.minPrecipIn) reasons.push(`${s.precipType === "snow" ? "Snow" : "Rain"} likely (${s.precipProb}%)`);
  const retractable = roof === "retractable";
  const flag = settings.enabled !== false && !retractable && reasons.length > 0;
  const whyNot = !reasons.length
    ? `Below thresholds (wind < ${settings.windMph} mph and gusts < ${settings.gustMph}; rain chance < ${settings.precipProbPct}% or under ${settings.minPrecipIn}"/hr; snow < ${settings.snowIn}")`
    : retractable
    ? "Retractable roof — it may be closed, so not flagged"
    : settings.enabled === false
    ? "Weather flags are turned off"
    : null;
  return { ...s, flag, reasons, whyNot, roofNote: retractable ? "Roof may be closed" : null };
}

async function gameDetail(g, settings) {
    const key = `${g.away}@${g.home}`;
    const st = g.neutralSite ? null : STADIUMS[g.home];
    let roof = st?.roof || null;
    if (g.neutralSite && g.venueIndoor === true) roof = "dome";
    const base = { key, home: g.home, away: g.away, kickoff: g.kickoffMillis, kickoffLabel: g.kickoffLabel, stadium: g.neutralSite ? g.venue || "Neutral site" : st?.name || g.venue || null, roof, neutralSite: Boolean(g.neutralSite) };
    let detail;
    if (roof === "dome") detail = { ...base, indoor: true, note: "Indoors — weather doesn't apply" };
    else if (!st) detail = { ...base, note: g.neutralSite ? "Neutral-site game — no forecast" : "Stadium unknown — no forecast" };
    else {
      try {
        const hours = await fetchForecast(st.lat, st.lon);
        const summary = evaluate(hours, g.kickoffMillis, roof, settings);
        const from = Math.floor(g.kickoffMillis / 3600e3) * 3600e3 - 2 * 3600e3;
        const hourly = hours
          .filter((h) => h.time >= from && h.time < from + 7 * 3600e3)
          .map((h) => ({
            time: h.time,
            temp: r1(h.temperature_2m),
            feelsLike: r1(h.apparent_temperature),
            wind: r1(h.wind_speed_10m),
            gust: r1(h.wind_gusts_10m),
            windDir: compass(h.wind_direction_10m),
            precipProb: h.precipitation_probability,
            precip: h.precipitation,
            snow: h.snowfall,
            type: precipType(h),
            conditions: WMO[h.weather_code] ?? null,
          }));
        detail = summary ? { ...base, ...summary, hourly } : { ...base, note: "Forecast not available yet for this kickoff" };
      } catch (err) {
        detail = { ...base, note: `Forecast unavailable (${err.message})` };
      }
    }
    return detail;
}

/** Weather for every game this week: { byTeam: {TEAM: summary}, games: [detail] } */
export async function getWeekWeather(season, week, sched = null) {
  const settings = getSettings();
  const s = sched || (await schedule.getWeekSchedule(season, week).catch(() => null));
  const byTeam = {};
  const games = [];
  const details = await Promise.all((s?.games || []).map((g) => gameDetail(g, settings)));
  for (const detail of details) {
    const key = detail.key;
    games.push(detail);
    const brief = {
      key,
      roof: detail.roof,
      indoor: Boolean(detail.indoor),
      temp: detail.temp ?? null,
      wind: detail.wind ?? null,
      gust: detail.gust ?? null,
      precipProb: detail.precipProb ?? null,
      precipType: detail.precipType ?? null,
      conditions: detail.conditions ?? null,
      flag: Boolean(detail.flag),
      reasons: detail.reasons || [],
      roofNote: detail.roofNote || null,
      note: detail.note || null,
    };
    byTeam[detail.home] = brief;
    byTeam[detail.away] = brief;
  }
  return { byTeam, games, settings };
}

export async function getGame(season, week, key) {
  const w = await getWeekWeather(season, week);
  return w.games.find((g) => g.key === key) || null;
}
