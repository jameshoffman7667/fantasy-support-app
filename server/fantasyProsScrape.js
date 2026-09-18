import * as cheerio from "cheerio";
import { cacheGet, cacheSet } from "./db.js";

/**
 * Scrapes FantasyPros' public projections pages instead of using their
 * API's /projections endpoint, which is capped at ~10 players/position
 * on the free tier. /consensus-rankings (server/fantasyPros.js) is NOT
 * capped the same way and stays on the API — this module only replaces
 * the one endpoint that was actually the problem.
 *
 * Confirmed before writing this:
 *  - robots.txt (fantasypros.com/robots.txt) explicitly allows crawling
 *    /nfl/projections/ — it only disallows /ranker/, /ajax/, /api/,
 *    /json/, /xml/ — with a Crawl-delay: 5 directive, which this module
 *    enforces in code, not just as a comment.
 *  - There's prior art: `ffpros`, an actively-maintained R package under
 *    the ffverse project, scrapes these same pages the same way.
 *  - Their Terms of Use may separately restrict automated access even
 *    where robots.txt is permissive — that's a real, unresolved tension
 *    (robots.txt is etiquette, not a license) that was flagged before
 *    building this, not glossed over.
 *
 * WHAT'S NOT VERIFIED: the exact table markup (class names, DOM
 * structure) below, since page-reading tools available while writing
 * this render pages as cleaned text/markdown, not raw HTML. The
 * confirmed facts are the URL pattern, query params, and that the table
 * has Player/Team/...stat columns/FPTS — matching what's shown at
 * fantasypros.com/nfl/projections/qb.php in a browser right now. The
 * parser below is written heuristically against that, and logs a
 * one-line sample on first real run so a mismatch is obvious immediately
 * rather than silently returning nothing. If it needs adjusting, check
 * that page's real HTML (browser dev tools -> Elements) against the
 * selectors here.
 */

const BASE = "https://www.fantasypros.com/nfl/projections";
const CRAWL_DELAY_MS = 5000; // robots.txt: Crawl-delay: 5
const CACHE_TTL_MS = 60 * 60 * 1000; // matches ffpros' own 1-hour page cache
const USER_AGENT =
  "FantasyManagerApp/1.0 (personal fantasy football tool; single-user; see github repo for source)";

let lastRequestAt = 0;
async function throttledFetch(url) {
  const wait = lastRequestAt + CRAWL_DELAY_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "text/html" } });
  if (!res.ok) throw new Error(`FantasyPros page fetch error ${res.status} on ${url}`);
  return res.text();
}

let _loggedSample = false;

function parseProjectionsPage(html, pos) {
  const $ = cheerio.load(html);

  // Find the table containing an "FPTS" column — more robust than
  // guessing a class name, since FPTS is the one column confirmed
  // present on every position's page.
  let $table = null;
  $("table").each((_, table) => {
    const headerText = $(table).find("th").text();
    if (headerText.includes("FPTS")) {
      $table = $(table);
      return false; // stop at first match
    }
  });
  if (!$table) return [];

  const rows = [];
  $table.find("tbody tr").each((_, tr) => {
    const $tr = $(tr);
    const $nameLink = $tr.find("a").first();
    const name = $nameLink.text().trim();
    if (!name) return;

    // Team abbreviation is plain text sitting next to the name link
    // within the same cell (not its own link) — pull whatever 2-4
    // uppercase-letter token appears in that cell's full text besides
    // the name itself.
    const cellText = $nameLink.closest("td").text().replace(name, "").trim();
    const teamMatch = cellText.match(/\b[A-Z]{2,4}\b/);
    const team = teamMatch ? teamMatch[0] : null;

    const cells = $tr.find("td");
    const lastCellText = $(cells[cells.length - 1]).text().trim();
    const fpts = Number(lastCellText.replace(/,/g, ""));
    if (Number.isNaN(fpts)) return;

    rows.push({ name, position_id: pos.toUpperCase(), team, fpts });
  });

  if (!_loggedSample && rows.length) {
    console.log(`[fantasyProsScrape] Sample parsed row for ${pos}:`, rows[0]);
    _loggedSample = true;
  }
  return rows;
}

async function getPositionProjections(pos, season, week, scoring) {
  const cacheKey = `fpscrape:${pos}-${week}-${scoring}`;
  const cached = cacheGet(cacheKey);
  if (cached !== null) return cached;

  const url = `${BASE}/${pos}.php?week=${week}&scoring=${scoring}`;
  const html = await throttledFetch(url);
  const data = parseProjectionsPage(html, pos);
  cacheSet(cacheKey, data, CACHE_TTL_MS);
  return data;
}

/**
 * Fetches projections for all four positions and returns them in one
 * flat array — deliberately NOT the API's { players: [...] } wrapper
 * shape, so buildLeague.js can't accidentally mix up which source a
 * given index came from.
 *
 * Sequential, not parallel — the crawl delay is enforced per-request
 * regardless, so parallelizing wouldn't actually be faster, and would
 * just make the "one request at a time" intent in the code less clear.
 * First call per (week, scoring) after cache expiry takes ~20s+ for the
 * 4 positions; every call within the hour after that is instant.
 */
export async function getAllProjections(season, week, scoring, positions = ["QB", "RB", "WR", "TE"]) {
  const all = [];
  for (const pos of positions) {
    try {
      const rows = await getPositionProjections(pos.toLowerCase(), season, week, scoring);
      all.push(...rows);
    } catch (err) {
      // One position failing to scrape (page structure change, network
      // blip) shouldn't take down projections for the other three.
      console.warn(`[fantasyProsScrape] Failed to get ${pos} projections: ${err.message}`);
    }
  }
  return all;
}
