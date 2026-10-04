import * as priv from "./sleeperPrivate.js";
import * as sleeper from "./sleeper.js";
import * as schedule from "./schedule.js";
import * as store from "./projectionStore.js";

/**
 * v3.0 — the per-user "private" data riding along with each built league:
 * trade offers (inbox + your own outstanding offers), pending waiver claims,
 * and the league settings change log. Attached at response time (never stored
 * in the shared build cache, since it depends on one user's token).
 *
 * attach(live=true)  → fetches from Sleeper (used by /api/leagues/build), saves a snapshot.
 * attach(live=false) → returns the last snapshot only, no network (used by /api/leagues/cached).
 * Every failure is reported in `error` fields and never fails the build.
 */
const snapKey = (u, l) => `private_snapshot:${u}:${l}`;
const marksKey = (u, l) => `push_marks:${u}:${l}`;

/**
 * v3.1 — push marks. A successful push from the app marks some variances as handled:
 *  - lineup push: records the lineup gap at push time (the gap rules stay quiet until it grows by
 *    more than a point) and the keys of variances a lineup push clears;
 *  - waiver push: records the keys of waiver-page variances it clears.
 * The client sends the gap and keys (it computed them); this just stores them, per user and league.
 */
export function recordPush(username, leagueId, kind, { week, gap, keys } = {}) {
  const cur = store.getState(marksKey(username, leagueId), null) || {};
  const cleanKeys = (Array.isArray(keys) ? keys : []).map(String).slice(0, 300);
  if (kind === "lineup") cur.lineup = { week: week ?? null, gap: Number.isFinite(Number(gap)) ? Number(gap) : 0, keys: cleanKeys, at: Date.now() };
  else if (kind === "waiver") cur.waiver = { keys: [...new Set([...(cur.waiver?.keys || []), ...cleanKeys])].slice(0, 600), at: Date.now() };
  else return null;
  store.setState(marksKey(username, leagueId), cur);
  return cur;
}
export const getMarks = (username, leagueId) => store.getState(marksKey(username, leagueId), null) || {};
const WEEK_MS = 7 * 24 * 3600 * 1000;
export const STALE_OFFSEASON_MS = WEEK_MS;

const etDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

/**
 * Turns Sleeper's trade rows into { incoming, outgoing } for one roster.
 * Stale (outgoing only, red): offseason → older than a week; in season → any
 * player involved has a game today or one that already kicked off this week.
 * `teamKickoff(team)` → ms of that team's game this week, or null.
 */
export function classifyTrades(rows, { myRosterId, myUserId, seasonType, now = Date.now(), teamKickoff = () => null, playerInfo = () => ({}), rosterLabel = () => null }) {
  const offseason = seasonType === "off" || seasonType === "pre";
  const incoming = [];
  const outgoing = [];
  for (const t of rows || []) {
    if (!t || !Array.isArray(t.roster_ids) || !t.roster_ids.map(Number).includes(Number(myRosterId))) continue;
    const mine = Number(myRosterId);
    const side = (rid, key) => Object.entries(t[key] || {}).filter(([, r]) => Number(r) === rid).map(([pid]) => pid);
    const getIds = side(mine, "adds");
    const giveIds = side(mine, "drops");
    const pick = (p) => `${p.season} round ${p.round}`;
    const getPicks = (t.draft_picks || []).filter((p) => Number(p.owner_id) === mine).map(pick);
    const givePicks = (t.draft_picks || []).filter((p) => Number(p.previous_owner_id) === mine).map(pick);
    const partnerId = (t.roster_ids || []).map(Number).find((r) => r !== mine) ?? null;
    const card = (pid) => ({ id: String(pid), ...playerInfo(pid) });
    const out = {
      id: String(t.transaction_id),
      leg: t.leg ?? null,
      created: t.created ?? null,
      ageDays: t.created ? Math.floor((now - t.created) / 86400000) : null,
      partnerRosterId: partnerId,
      partner: rosterLabel(partnerId),
      get: getIds.map(card),
      give: giveIds.map(card),
      getPicks,
      givePicks,
      direction: String(t.creator) === String(myUserId) ? "outgoing" : "incoming",
    };
    if (out.direction === "outgoing") {
      let stale = null;
      if (offseason) {
        if (t.created && now - t.created > STALE_OFFSEASON_MS) stale = `Offer is ${out.ageDays} days old (offseason limit: 7).`;
      } else {
        const hit = [...out.get, ...out.give].find((p) => {
          const ko = p.team ? teamKickoff(p.team) : null;
          return ko != null && etDay(ko) <= etDay(now);
        });
        if (hit) stale = `${hit.name || hit.id} (${hit.team}) plays today or has already played this week.`;
      }
      out.stale = stale;
      outgoing.push(out);
    } else incoming.push(out);
  }
  return { incoming, outgoing };
}

/** A readable line for each settings-change log row. */
export function summarizeLog(row) {
  const d = row?.data || {};
  const who = d.usernames && d.user_id ? d.usernames[d.user_id] || d.user_id : d.user_id || "someone";
  const changes = d.changes && typeof d.changes === "object" ? Object.entries(d.changes) : [];
  const fmt = (v) => (v == null ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));
  const text = changes.length ? `${who}: ${changes.map(([k, c]) => `${k} ${fmt(c?.old)} → ${fmt(c?.new)}`).join("; ")}` : `${who}: ${String(row?.event_type || "change").replace(/_/g, " ")}`;
  return { id: String(row.log_id), at: row.created ?? null, type: row.event_type || null, text: text.slice(0, 400) };
}

async function fetchLeague(username, lg, ctx) {
  const info = { at: Date.now() };
  const tasks = [];
  const roster = (lg.leagueTeams || []).reduce((m, t) => ((m[t.rosterId] = t.label), m), {});
  const players = ctx.players || {};
  const playerInfo = (pid) => {
    const m = players[pid];
    return m ? { name: `${m.first_name || ""} ${m.last_name || ""}`.trim() || pid, pos: m.position || "?", team: m.team || null } : {};
  };
  const leg = lg.week;
  tasks.push(
    priv.getProposedTrades(username, lg.id, leg).then(
      (rows) => (info.trades = { ...classifyTrades(rows, { myRosterId: lg.myRosterId, myUserId: lg.ownerId, seasonType: ctx.seasonType, teamKickoff: ctx.teamKickoff, playerInfo, rosterLabel: (r) => roster[r] || (r != null ? `Team ${r}` : null) }), legChecked: leg }),
      (e) => (info.trades = { incoming: [], outgoing: [], error: e.message })
    ),
    priv.getEventLogs(username, lg.id).then(
      (rows) => (info.log = { items: rows.map(summarizeLog) }),
      (e) => (info.log = { items: [], error: e.message })
    ),
    priv.getPendingClaims(username, lg.id, leg, lg.myRosterId).then(
      (r) => (info.claims = { pending: r.claims.map((c) => ({ id: String(c.transaction_id), adds: Object.keys(c.adds || {}), drops: Object.keys(c.drops || {}), bid: c.settings?.waiver_bid ?? null, status: c.status })), statuses: r.statuses }),
      (e) => (info.claims = { pending: [], statuses: [], error: e.message })
    )
  );
  await Promise.all(tasks);
  return info;
}

export async function attach(username, leagues, { live = false } = {}) {
  const st = priv.status(username);
  if (!st.configured) return leagues.map((l) => (l.error ? l : { ...l, privateInfo: { configured: false } }));
  // v3.1: reads switched off → no private data at all (and no calls); the client hides the private-only parts.
  if (!st.perms.reads) return leagues.map((l) => (l.error ? l : { ...l, pushMarks: getMarks(username, l.id), privateInfo: { configured: true, readsOff: true, perms: st.perms, writesEnabled: st.writesEnabled } }));
  let ctx = null;
  if (live) {
    const [state, players] = await Promise.all([sleeper.getState().catch(() => null), sleeper.getPlayers().catch(() => ({}))]);
    const week = state?.week;
    const sched = state && week ? await schedule.getWeekSchedule(Number(state.season), Number(week), { live: false }).catch(() => null) : null;
    ctx = { seasonType: state?.season_type || "regular", players, teamKickoff: (team) => sched?.byTeam?.[team]?.kickoffMillis ?? null };
  }
  return Promise.all(
    leagues.map(async (l) => {
      if (l.error) return l;
      let info;
      if (live) {
        info = await fetchLeague(username, l, ctx);
        store.setState(snapKey(username, l.id), info);
      } else {
        info = store.getState(snapKey(username, l.id), null) || { empty: true };
      }
      return { ...l, pushMarks: getMarks(username, l.id), privateInfo: { configured: true, perms: st.perms, writesEnabled: st.writesEnabled, ...info } };
    })
  );
}
