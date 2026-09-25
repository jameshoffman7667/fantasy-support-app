/**
 * ESPN's scoreboard endpoint is undocumented but public, free, and needs
 * no key — confirmed live against the real 2026 season. It returns exact
 * kickoff time per game and both teams' abbreviations, which is exactly
 * what's needed to close the gap Sleeper and FantasyPros both leave open
 * (neither exposes kickoff times or bye weeks).
 *
 * This is unofficial: ESPN could change the shape without notice. Every
 * field this module reads is defensively optional-chained, and a failure
 * here degrades to "kickoff time unknown" rather than breaking the build.
 */
const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
import { cacheGet, cacheSet } from "./db.js";

// A handful of teams where Sleeper's abbreviation and ESPN's don't always
// agree. Not exhaustive by construction — anything not listed here is
// assumed to already match, and a genuine mismatch just results in that
// team's players showing "kickoff time unknown" rather than a crash.
const TEAM_ALIASES = {
  WSH: "WAS",
  JAX: "JAC",
};
function normalizeTeam(abbr) {
  if (!abbr) return abbr;
  const upper = abbr.toUpperCase();
  return TEAM_ALIASES[upper] || upper;
}

const CACHE_TTL_MS = 15 * 60 * 1000; // schedules don't change once the week is set, but flex/TNF flexes and weather delays do get reflected here over time

export async function getWeekSchedule(season, week) {
  const cacheKey = `espn-schedule:${season}-${week}`;
  const cached = cacheGet(cacheKey);
  if (cached !== null) return cached;

  // Confirmed working format via multiple independent sources:
  // ?dates=YYYY&seasontype={type}&week={n} — NOT year=YYYY, which this
  // used before. BUT: even with the correct params, a live test still
  // came back with a different week's data than requested — several
  // sources reference this exact endpoint silently caching/ignoring
  // query params, with "append a cache-busting value" as the known
  // workaround. Both applied here: a nonce param, and explicit
  // validation that the response's own week number matches what was
  // asked for, logged loudly rather than silently trusted if it doesn't.
  const cacheBuster = Date.now();
  const url = `${ESPN_BASE}?dates=${season}&seasontype=2&week=${week}&_=${cacheBuster}`;
  const res = await fetch(url, { headers: { "Cache-Control": "no-cache", Pragma: "no-cache" } });
  if (!res.ok) {
    throw new Error(`ESPN scoreboard error ${res.status} for week ${week}`);
  }
  const json = await res.json();

  if (json.week?.number != null && json.week.number !== week) {
    console.warn(
      `[schedule] Requested week ${week} but ESPN returned week ${json.week.number} — game times below are for the WRONG week. This endpoint is known to sometimes ignore query params; if this keeps happening, kickoff times/byes should be treated as unreliable until ESPN's behavior is re-verified.`
    );
  }

  const byTeam = {}; // normalized team abbr -> { kickoffISO, kickoffLabel, opponent }
  const teamsPlaying = new Set();

  for (const event of json.events || []) {
    const competition = event.competitions?.[0];
    const isoDate = competition?.date || event.date;
    if (!isoDate) continue;
    const kickoffLabel = formatKickoff(isoDate);

    const competitors = competition?.competitors || [];
    for (const comp of competitors) {
      const abbr = normalizeTeam(comp.team?.abbreviation);
      if (!abbr) continue;
      const opponent = competitors.find((c) => c !== comp);
      teamsPlaying.add(abbr);
      byTeam[abbr] = {
        kickoffISO: isoDate,
        kickoffMillis: Date.parse(isoDate),
        kickoffLabel,
        opponent: normalizeTeam(opponent?.team?.abbreviation) || null,
      };
    }
  }

  const data = { byTeam, teamsPlaying: [...teamsPlaying], weekNumber: json.week?.number ?? week };
  cacheSet(cacheKey, data, CACHE_TTL_MS);
  return data;
}

function formatKickoff(isoDate) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(isoDate)) + " ET";
  } catch {
    return "Kickoff time unavailable";
  }
}

// The 32 current NFL team abbreviations, normalized. A rostered player
// whose team isn't in `teamsPlaying` for the week is on bye — this is how
// bye weeks get detected, since neither Sleeper nor FantasyPros publish a
// bye-week schedule directly.
export const ALL_NFL_TEAMS = [
  "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN",
  "DET", "GB", "HOU", "IND", "JAC", "KC", "LAC", "LAR", "LV", "MIA",
  "MIN", "NE", "NO", "NYG", "NYJ", "PHI", "PIT", "SEA", "SF", "TB",
  "TEN", "WAS",
];

export { normalizeTeam };
