import fs from "fs";
import path from "path";
import * as store from "./projectionStore.js";

/**
 * v2.8 headshot / team-logo proxy with an on-disk cache under DATA_DIR/img.
 *
 * Headshots: Sleeper's CDN by Sleeper ID first, then ESPN's by the ESPN ID
 * from the crosswalk. Logos: Sleeper's CDN, then ESPN's. If both fail, a
 * 404 and the client draws initials / the abbreviation instead; misses are
 * remembered for a day so a missing photo isn't re-requested on every view.
 * URL patterns are the ones other projects use; not fetchable from the
 * build sandbox, so unverified here.
 */
const DATA_DIR = process.env.DATA_DIR || "./data";
const DIR = path.join(DATA_DIR, "img");
const HIT_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const MISS_TTL_MS = 24 * 3600 * 1000;
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

const SLEEPER_TEAM = { JAC: "jax", WAS: "was", LAR: "lar" };
const ESPN_TEAM = { JAC: "jax", WAS: "wsh", LAR: "lar" };

export function headshotUrls(sleeperId, espnId) {
  const urls = [];
  if (/^\d+$/.test(String(sleeperId))) urls.push(`https://sleepercdn.com/content/nfl/players/thumb/${sleeperId}.jpg`);
  if (espnId) urls.push(`https://a.espncdn.com/i/headshots/nfl/players/full/${espnId}.png`);
  return urls;
}
export function logoUrls(team) {
  const t = String(team || "").toUpperCase();
  if (!/^[A-Z]{2,3}$/.test(t)) return [];
  return [`https://sleepercdn.com/images/team_logos/nfl/${SLEEPER_TEAM[t] || t.toLowerCase()}.png`, `https://a.espncdn.com/i/teamlogos/nfl/500/${ESPN_TEAM[t] || t.toLowerCase()}.png`];
}

function filePaths(kind, id) {
  const safe = String(id).replace(/[^A-Za-z0-9_-]/g, "");
  return { img: path.join(DIR, kind, `${safe}.img`), meta: path.join(DIR, kind, `${safe}.json`) };
}

async function fetchFirst(urls) {
  for (const u of urls) {
    try {
      const res = await fetch(u, { headers: { "User-Agent": UA, Accept: "image/*" } });
      const type = res.headers.get("content-type") || "";
      if (!res.ok || !type.startsWith("image/")) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 200) continue; // placeholder / empty image
      return { buf, type, url: u };
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Returns { buf, type } or null. Cached on disk (hits 30 days, misses 1 day). */
export async function getImage(kind, id) {
  if (!["player", "team"].includes(kind) || !id) return null;
  const p = filePaths(kind, id);
  try {
    const meta = JSON.parse(fs.readFileSync(p.meta, "utf8"));
    const age = Date.now() - meta.at;
    if (meta.miss && age < MISS_TTL_MS) return null;
    if (!meta.miss && age < HIT_MAX_AGE_MS && fs.existsSync(p.img)) return { buf: fs.readFileSync(p.img), type: meta.type };
  } catch {
    /* not cached */
  }
  let urls;
  if (kind === "team") urls = logoUrls(id);
  else if (!/^\d+$/.test(String(id))) urls = logoUrls(id); // DEF "players" are team abbreviations
  else {
    const ext = store.externalIds(id);
    const cw = store.getCrosswalk(id);
    urls = headshotUrls(id, cw?.espn_id || ext?.ffb_ids?.espn_id || null);
  }
  const got = await fetchFirst(urls);
  fs.mkdirSync(path.dirname(p.img), { recursive: true });
  if (!got) {
    fs.writeFileSync(p.meta, JSON.stringify({ miss: true, at: Date.now() }));
    return null;
  }
  fs.writeFileSync(p.img, got.buf);
  fs.writeFileSync(p.meta, JSON.stringify({ type: got.type, url: got.url, at: Date.now() }));
  return { buf: got.buf, type: got.type };
}
