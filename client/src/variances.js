// v2.8.1 variance report + "clear minor variances" (v2.9: auto-clearing rules).
//
// Every yellow (minor) or red (major) flag in a league's pages becomes one
// variance: { key, leagueId, league, page, rule, subject, text, severity }.
// The key identifies the issue without its changing numbers (league + week
// where it matters + page + rule + player/subject), so the same issue with
// a different points gap or wind speed is still "the same one".
//
// Clearing marks the visible minor variances in a pop-up's scope as
// acknowledged (saved per user on the server). A cleared minor stops
// colouring its row, page badge and league card. A NEW variance (any key not
// cleared) colours them again; a cleared minor that becomes major always
// shows (reds can't be cleared). Acknowledgements for issues that have gone
// away are pruned, so if the same issue comes back later it's new again.
//
// v2.9: some minor variances are "auto-clearing" (a weather warning, a big-gap
// trade opportunity): they show on the first visit to their page and are
// acknowledged automatically once the page has been viewed and left
// (see autoClearKeys). If the same issue goes away and returns later it's new
// again. Incoming trade offers deliberately do NOT auto-clear.
//
// Pure — no React — so it can be unit-tested.

// v3.0: Roster and Lineup are one page ("roster"); League (settings change log) is new.
export const PAGES = ["roster", "waiver", "trade", "injury", "league"];
export const PAGE_LABEL = { roster: "Roster & Lineup", waiver: "Waivers", trade: "Trade Radar", injury: "Injury Watch", league: "League" };
const RANK = { ok: 0, minor: 1, major: 2 };
export const worst = (list) => list.reduce((acc, s) => (RANK[s] > RANK[acc] ? s : acc), "ok");

// Week-specific pages carry the week in their keys; waivers, trades and
// injuries don't (an injury you've cleared stays cleared into next week
// unless its status changes).
const WEEKLY = new Set(["roster"]);
export function varianceKey(leagueId, week, page, rule, subject) {
  return [leagueId, WEEKLY.has(page) ? `W${week ?? "?"}` : "W*", page, rule, subject].join("|");
}
export function keyParts(key) {
  const [leagueId, w, page] = String(key).split("|");
  return { leagueId, week: w?.slice(1), page };
}

/**
 * All variances for one computed league (roster/lineup/waiver/trade/injury
 * already computed). Roster rows carry `issues` (see App.jsx computeRoster).
 */
export function collectVariances(lg) {
  if (!lg || lg.error) return [];
  const out = [];
  const add = (page, rule, subject, severity, text, auto = false) => {
    if (severity !== "minor" && severity !== "major") return;
    out.push({ key: varianceKey(lg.id, lg.week, page, rule, subject), leagueId: lg.id, league: lg.name, page, rule, subject, severity, text: text || subject, auto: Boolean(auto) && severity === "minor" });
  };

  // Roster: one variance per rule broken per row.
  for (const r of lg.roster?.rows || []) {
    for (const i of r.issues || []) add("roster", i.rule, `${r.slot} ${r.label}`, i.severity, `${r.slot} ${r.label}: ${i.text}`);
  }

  // Lineup.
  const L = lg.lineup;
  if (L) {
    for (const p of L.zeroStarters || []) add("roster", "Starter projected for 0 points", p.name, "major", `${p.name} is projected for 0 points`);
    if (L.custom) {
      const changed = (L.rows || []).filter((r) => r.changed);
      if (changed.length) {
        const swing = changed.reduce((s, r) => s + Math.abs(r.delta), 0);
        add("roster", "Lineup differs from your ranking", "Starting lineup", swing < 5 ? "minor" : "major", `Your ranking changes ${changed.length} slot(s) (${swing.toFixed(1)} pts): ${changed.map((r) => `${r.slot} ${r.current?.name ?? "(empty)"} → ${r.optimal?.name ?? "(none)"}`).join(", ")}`);
      }
      if ((L.betterDelta ?? 0) > 0.05) add("roster", "Better lineup than your ranking", "Player Rankings", "minor", `A better projected lineup exists: +${L.betterDelta.toFixed(1)} pts over your ranking`);
    } else if ((L.delta ?? 0) > 0) {
      const changed = (L.rows || []).filter((r) => r.changed);
      add("roster", "Optimal lineup is better", "Starting lineup", L.delta < 5 ? "minor" : "major", `Optimal lineup gains +${L.delta.toFixed(1)} pts${changed.length ? `: ${changed.map((r) => `${r.slot} ${r.current?.name ?? "(empty)"} → ${r.optimal?.name ?? "(none)"}`).join(", ")}` : ""}`);
    }
    for (const p of L.weatherStarters || []) add("roster", "Weather", p.name, "minor", `${p.name} (${p.team}): ${(p.weather?.reasons || []).join("; ")}`, true);
  }
  // v2.9: a starter or bench player with no projection from any source (kept
  // for troubleshooting; IR / taxi players can't be started so aren't checked).
  const noProj = [...(lg.starters || []).map((s) => (s.player ? { p: s.player, slot: s.slot } : null)), ...(lg.bench || []).map((p) => (p ? { p, slot: "BN" } : null))];
  for (const x of noProj) {
    if (x && x.p.proj == null && !x.p.played) add("roster", "No projection for player", `${x.slot} ${x.p.name}`, "minor", `${x.p.name} (${x.slot}) has no projection from any source`);
  }

  // Waivers (v2.9): by projection, not ECR or trending. `fa.rule` / `fa.note`
  // are set in computeWaiver (App.jsx).
  for (const fa of lg.waiver?.rows || []) {
    if (fa.rule) add("waiver", fa.rule, fa.name, fa.severity, `${fa.name} (${fa.pos}) — ${fa.note}`);
  }

  // Trades. Only big-gap opportunities are flagged (yellow, auto-clearing);
  // smaller ones are shown on the page but are not variances.
  for (const t of lg.trade?.rows || []) add("trade", "Trade opportunity (big gap)", `${t.theirTeam}: give ${t.give}, get ${t.get}`, t.severity, `${t.theirTeam}: give ${t.give}, get ${t.get}`, t.auto);

  // v3.0 (needs the Sleeper token): offers waiting on you are yellow and do NOT auto-clear (N03);
  // an offer YOU made that has gone stale is red (N02). Resolved offers disappear on their own.
  const T = lg.privateInfo?.trades;
  for (const o of T?.incoming || []) add("trade", "Incoming trade offer", `offer ${o.id}`, "minor", `Offer from ${o.partner || "another team"}: you get ${offerSide(o.get, o.getPicks)}, you give ${offerSide(o.give, o.givePicks)}`);
  for (const o of T?.outgoing || []) if (o.stale) add("trade", "Stale trade offer", `offer ${o.id}`, "major", `Your offer to ${o.partner || "another team"} (you give ${offerSide(o.give, o.givePicks)}, you get ${offerSide(o.get, o.getPicks)}): ${o.stale}`);

  // v3.0: League page — every settings change in the log is a minor variance until cleared.
  for (const it of lg.privateInfo?.log?.items || []) add("league", "Settings change", `log ${it.id}`, "minor", it.text);

  // Injuries.
  for (const e of lg.injury?.rows || []) {
    add("injury", e.seen ? "Injury status (seen before)" : "New injury status", `${e.player} (${e.status})`, e.seen ? "minor" : "major", `${e.player}: ${e.status}${e.note ? ` — ${e.note}` : ""}`);
  }
  return out;
}

const offerSide = (players, picks) => [...(players || []).map((p) => p.name || p.id), ...(picks || [])].join(", ") || "nothing";

export const isCleared = (v, acks) => v.severity === "minor" && acks.has(v.key);

/**
 * Returns a copy of the computed league with acknowledged minors applied:
 * page statuses and row colours ignore cleared minors, and `variances`
 * lists every variance with a `cleared` flag.
 */
export function applyAcks(lg, acks) {
  if (!lg || lg.error) return lg;
  const variances = collectVariances(lg).map((v) => ({ ...v, cleared: isCleared(v, acks) }));
  const live = variances.filter((v) => !v.cleared);
  const status = (page) => worst(live.filter((v) => v.page === page).map((v) => v.severity));
  const clearedKey = (page, rule, subject) => acks.has(varianceKey(lg.id, lg.week, page, rule, subject));

  const rosterRows = (lg.roster.rows || []).map((r) => {
    const issues = (r.issues || []).map((i) => ({ ...i, cleared: i.severity === "minor" && clearedKey("roster", i.rule, `${r.slot} ${r.label}`) }));
    const open = issues.filter((i) => !i.cleared);
    return { ...r, issues, severity: worst(open.map((i) => i.severity)), reason: open.map((i) => i.text).join(" ") || null, clearedNote: issues.some((i) => i.cleared) || undefined };
  });
  const lineupCleared = new Set(variances.filter((v) => v.page === "roster" && v.cleared).map((v) => v.rule + "|" + v.subject));
  const lineup = {
    ...lg.lineup,
    status: status("roster"),
    weatherStarters: (lg.lineup.weatherStarters || []).filter((p) => !lineupCleared.has(`Weather|${p.name}`)),
    betterCleared: lineupCleared.has("Better lineup than your ranking|Player Rankings"),
  };
  const waiverRows = (lg.waiver.rows || []).map((fa) => {
    const v = variances.find((x) => x.page === "waiver" && x.subject === fa.name);
    return v?.cleared ? { ...fa, severity: "ok", cleared: true } : fa;
  });
  const tradeRows = (lg.trade.rows || []).map((t) => {
    const v = variances.find((x) => x.page === "trade" && x.subject === `${t.theirTeam}: give ${t.give}, get ${t.get}`);
    return v?.cleared ? { ...t, severity: "ok", cleared: true } : t;
  });
  const injuryRows = (lg.injury.rows || []).map((e) => {
    const v = variances.find((x) => x.page === "injury" && x.subject === `${e.player} (${e.status})`);
    return v?.cleared ? { ...e, cleared: true } : e;
  });
  const offerCleared = (rule, o) => acks.has(varianceKey(lg.id, lg.week, "trade", rule, `offer ${o.id}`));
  const T = lg.privateInfo?.trades;
  const tradeOffers = T ? { ...T, incoming: (T.incoming || []).map((o) => ({ ...o, cleared: offerCleared("Incoming trade offer", o) })), outgoing: (T.outgoing || []).map((o) => ({ ...o, cleared: false })) } : null;
  const logItems = (lg.privateInfo?.log?.items || []).map((it) => ({ ...it, cleared: acks.has(varianceKey(lg.id, lg.week, "league", "Settings change", `log ${it.id}`)) }));
  const leaguePage = { configured: Boolean(lg.privateInfo?.configured), error: lg.privateInfo?.log?.error || null, items: logItems, status: lg.privateInfo?.configured ? status("league") : "na" };
  return {
    ...lg,
    variances,
    tradeOffers,
    leaguePage,
    league: leaguePage, // the League page's badge reads lg.league.status like the other pages
    roster: { ...lg.roster, rows: rosterRows, status: status("roster") },
    lineup,
    waiver: { ...lg.waiver, rows: waiverRows, status: status("waiver") },
    trade: { ...lg.trade, rows: tradeRows, status: status("trade") },
    injury: { ...lg.injury, rows: injuryRows, status: status("injury") },
  };
}

/** League -> page -> rule -> items, each level with its worst severity (cleared items excluded from the rollup). */
export function groupTree(variances) {
  const leagues = [];
  const byLeague = new Map();
  for (const v of variances) {
    if (!byLeague.has(v.leagueId)) {
      const l = { id: v.leagueId, name: v.league, pages: [], byPage: new Map() };
      byLeague.set(v.leagueId, l);
      leagues.push(l);
    }
    const l = byLeague.get(v.leagueId);
    if (!l.byPage.has(v.page)) {
      const p = { page: v.page, label: PAGE_LABEL[v.page] || v.page, rules: [], byRule: new Map() };
      l.byPage.set(v.page, p);
      l.pages.push(p);
    }
    const p = l.byPage.get(v.page);
    if (!p.byRule.has(v.rule)) {
      const r = { rule: v.rule, items: [] };
      p.byRule.set(v.rule, r);
      p.rules.push(r);
    }
    p.byRule.get(v.rule).items.push(v);
  }
  const sev = (items) => worst(items.filter((v) => !v.cleared).map((v) => v.severity));
  for (const l of leagues) {
    l.pages.sort((a, b) => PAGES.indexOf(a.page) - PAGES.indexOf(b.page));
    for (const p of l.pages) {
      for (const r of p.rules) r.severity = sev(r.items);
      p.rules.sort((a, b) => RANK[b.severity] - RANK[a.severity] || a.rule.localeCompare(b.rule));
      p.severity = worst(p.rules.map((r) => r.severity));
    }
    l.severity = worst(l.pages.map((p) => p.severity));
    delete l.byPage;
    for (const p of l.pages) delete p.byRule;
  }
  return leagues;
}

/**
 * v2.9: keys of auto-clearing minor variances in a scope (a league + page),
 * to acknowledge once that page has been viewed and left.
 */
export function autoClearKeys(variances, { leagueId, page } = {}) {
  return [...new Set(variances.filter((v) => v.auto && v.severity === "minor" && !v.cleared && (!leagueId || v.leagueId === leagueId) && (!page || v.page === page)).map((v) => v.key))];
}

/** Keys to acknowledge when "Clear minor variances" is pressed in a scope. */
export function minorKeys(variances) {
  return [...new Set(variances.filter((v) => v.severity === "minor" && !v.cleared).map((v) => v.key))];
}
