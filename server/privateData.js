import * as priv from "./sleeperPrivate.js";
import * as sleeper from "./sleeper.js";
import * as schedule from "./schedule.js";
import * as store from "./projectionStore.js";
import * as values from "./values.js"; // v3.5: value of each side of an offer

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
    const pickDetail = (p) => ({ season: Number(p.season), round: Number(p.round), originalRosterId: p.roster_id != null ? Number(p.roster_id) : null });
    const getPickRows = (t.draft_picks || []).filter((p) => Number(p.owner_id) === mine);
    const givePickRows = (t.draft_picks || []).filter((p) => Number(p.previous_owner_id) === mine);
    const getPicks = getPickRows.map(pick);
    const givePicks = givePickRows.map(pick);
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
      getPicksDetail: getPickRows.map(pickDetail), // v3.5: for pick values (season, round, original owner)
      givePicksDetail: givePickRows.map(pickDetail),
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

const TX_SNAPSHOT_MS = 6 * 3600 * 1000; // R24: trade offers + pending claims are re-read from Sleeper every 6 hours
const LOG_SNAPSHOT_MS = WEEK_MS; // R25: the league change log weekly
export const dirtyKey = (username, leagueId) => `priv_dirty:${username}:${leagueId}`;

async function fetchLeague(username, lg, ctx, prev = null, { force = false } = {}) {
  const now = Date.now();
  const info = { at: now };
  const tasks = [];
  // v3.5: real team names (the v3.0-v3.4 lookup read fields leagueTeams didn't have, so offers said "Team 3").
  const roster = { ...(lg.leagueTeams || []).reduce((m, t) => (t.rosterId != null ? ((m[t.rosterId] = t.label || t.team), m) : m), {}), ...(lg.rosterLabels || {}) };
  const players = ctx.players || {};
  const playerInfo = (pid) => {
    const m = players[pid];
    return m ? { name: `${m.first_name || ""} ${m.last_name || ""}`.trim() || pid, pos: m.position || "?", team: m.team || null } : {};
  };
  // v4.1: Sleeper's own week for trades (the app's week moves on Tuesday 10:00, Sleeper's later); claims are read
  // under Sleeper's week AND the next one, since a claim made after the change is filed under the coming week.
  const leg = Number(ctx.sleeperWeek ?? lg.week);
  const claimLegs = priv.claimLegs(leg, leg + 1, lg.week);
  const classify = (rows) => ({ ...classifyTrades(rows, { myRosterId: lg.myRosterId, myUserId: lg.ownerId, seasonType: ctx.seasonType, teamKickoff: ctx.teamKickoff, playerInfo, rosterLabel: (r) => roster[r] || (r != null ? `Team ${r}` : null) }), legChecked: leg });
  const dirty = store.getState(dirtyKey(username, lg.id), 0) || 0; // a push of yours makes the snapshot out of date
  // v3.5: a manual refresh (force) always re-reads trade offers and pending claims.
  const txFresh = !force && prev && prev.rawTrades && prev.claims && !prev.claims.error && prev.legChecked === leg && prev.txAt && now - prev.txAt < TX_SNAPSHOT_MS && dirty <= prev.txAt;
  if (txFresh) {
    // Snapshot reused; the red "stale" flag depends on today's date and kickoffs, so it is recomputed on every page load.
    info.rawTrades = prev.rawTrades;
    info.trades = classify(prev.rawTrades);
    info.claims = prev.claims;
    info.txAt = prev.txAt;
    info.legChecked = leg;
  } else {
    info.txAt = now;
    info.legChecked = leg;
    tasks.push(
      priv.getProposedTrades(username, lg.id, leg).then(
        (rows) => { info.rawTrades = rows; info.trades = classify(rows); },
        (e) => { info.txAt = 0; info.trades = { incoming: [], outgoing: [], error: e.message }; }
      ),
      priv.getPendingClaims(username, lg.id, claimLegs, lg.myRosterId).then(
        (r) => (info.claims = { pending: r.claims.map((c) => ({ id: String(c.transaction_id), adds: Object.keys(c.adds || {}), drops: Object.keys(c.drops || {}), bid: c.settings?.waiver_bid ?? null, status: c.status, leg: c.leg ?? null })), statuses: r.statuses, legs: r.legs }),
        (e) => { info.txAt = 0; info.claims = { pending: [], statuses: [], error: e.message }; }
      )
    );
  }
  if (prev && prev.log && !prev.log.error && prev.logAt && now - prev.logAt < LOG_SNAPSHOT_MS) {
    info.log = prev.log;
    info.logAt = prev.logAt;
  } else {
    info.logAt = now;
    tasks.push(
      priv.getEventLogs(username, lg.id).then(
        (rows) => (info.log = { items: rows.map(summarizeLog) }),
        (e) => { info.logAt = 0; info.log = { items: [], error: e.message }; }
      )
    );
  }
  await Promise.all(tasks);
  return info;
}

/**
 * v3.5: each offer gets `value` — the two sides valued with the league's trade-value table (dynasty: Roster Audit,
 * redraft/keeper: FantasyCalc), verdict win/fair/loss at ±10%. In dynasty leagues a live refresh also asks Roster
 * Audit's calculator for its own verdict and age warnings (`ra`, at most ~35 calls an hour, cached 6 hours).
 */
async function decorateOffers(lg, trades, { live }) {
  if (!trades || trades.error) return trades;
  const all = [...(trades.incoming || []), ...(trades.outgoing || [])];
  if (!all.length) return trades;
  const vp = lg.valueParams || {};
  let vals = null;
  try {
    vals = await values.leagueValues({ dynasty: lg.leagueType === "dynasty", superflex: Boolean(lg.superflex), ppr: vp.ppr ?? 1, tep: Boolean(vp.tep), teams: vp.teams ?? 12 });
  } catch {
    vals = null;
  }
  const decorate = async (o) => {
    const value = vals ? values.valueOffer(o, vals, { superflex: Boolean(lg.superflex), pickSlotOf: (rid) => lg.pickSlots?.[rid] || "mid" }) : null;
    let ra = null;
    if (vals?.source === "Roster Audit") {
      const side = (players, picks) => [
        ...(players || []).map((p) => ({ type: "player", id: String(p.id) })),
        ...(picks || []).map((pk) => ({ type: "pick", season: pk.season, round: pk.round, slot: lg.pickSlots?.[pk.originalRosterId] || "mid" })),
      ];
      ra = await values.raCalc({ sideA: side(o.get, o.getPicksDetail), sideB: side(o.give, o.givePicksDetail), superflex: Boolean(lg.superflex) }, { cacheOnly: !live }).catch(() => null);
    }
    return { ...o, value, ra };
  };
  return { ...trades, incoming: await Promise.all((trades.incoming || []).map(decorate)), outgoing: await Promise.all((trades.outgoing || []).map(decorate)) };
}

export const _decorateOffersForTests = decorateOffers;

export async function attach(username, leagues, { live = false, force = false } = {}) {
  const st = priv.status(username);
  if (!st.configured) return leagues.map((l) => (l.error ? l : { ...l, privateInfo: { configured: false } }));
  // v3.1: reads switched off → no private data at all (and no calls); the client hides the private-only parts.
  if (!st.perms.reads) return leagues.map((l) => (l.error ? l : { ...l, pushMarks: getMarks(username, l.id), privateInfo: { configured: true, readsOff: true, perms: st.perms, writesEnabled: st.writesEnabled } }));
  let ctx = null;
  if (live) {
    const [state, players] = await Promise.all([sleeper.getState().catch(() => null), sleeper.getPlayers().catch(() => ({}))]);
    const week = state?.week;
    const sched = state && week ? await schedule.getWeekSchedule(Number(state.season), Number(week), { live: false }).catch(() => null) : null;
    ctx = { seasonType: state?.season_type || "regular", sleeperWeek: state?.sleeperWeek ?? state?.week ?? null, players, teamKickoff: (team) => sched?.byTeam?.[team]?.kickoffMillis ?? null };
  }
  return Promise.all(
    leagues.map(async (l) => {
      if (l.error) return l;
      let info;
      if (live) {
        info = await fetchLeague(username, l, ctx, store.getState(snapKey(username, l.id), null), { force });
        store.setState(snapKey(username, l.id), info);
      } else {
        info = store.getState(snapKey(username, l.id), null) || { empty: true };
      }
      if (info?.trades) info = { ...info, trades: await decorateOffers(l, info.trades, { live }).catch(() => info.trades) };
      return { ...l, pushMarks: getMarks(username, l.id), privateInfo: { configured: true, perms: st.perms, writesEnabled: st.writesEnabled, ...info } };
    })
  );
}
