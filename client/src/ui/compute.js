import { effectiveLineup, flexTimingPairs, hasStarted, isLocked, slotEligible } from "../lineup.js";
import { worst } from "./theme.js";

/* ------------------------------------------------------------------ */
/*  VARIANCE CALCULATIONS                                             */
/* ------------------------------------------------------------------ */
const OUT_LIKE = ["Out", "Doubtful", "IR", "Suspended", "NA"];

// v2.8.1: each row lists the rules it breaks (`issues`), so the variance
// report can group by rule; severity/reason are derived from them.
export function computeRoster(league) {
  const iss = (rule, severity, text) => ({ rule, severity, text });
  const starterRows = league.starters.map(({ slot, player }) => {
    if (!player) return { slot, label: "(empty)", issues: [iss("Empty starting slot", "major", "Empty starting roster slot")] };
    if (player.status === "Bye") return { slot, label: player.name, issues: [iss("Starter on bye", "major", "On bye — guaranteed zero")] };
    // v3.4: once his game has kicked off he is locked in his slot — no move can fix anything, so no flag.
    if (OUT_LIKE.includes(player.status)) return { slot, label: player.name, issues: isLocked(player, league) ? [] : [iss("Starter out / doubtful / IR", "major", player.note || `${player.status} — hasn't been swapped`)] };
    // v3.1: a Questionable starter stops being flagged once his game has kicked off, and is flagged
    // again after the week's last game if he still carries the status.
    if (player.status === "Questionable") {
      if (hasStarted(player) && !league.weekOver) return { slot, label: player.name, issues: [] };
      return { slot, label: player.name, issues: [iss("Questionable starter", "minor", player.note || "Questionable — game-time decision")] };
    }
    return { slot, label: player.name, issues: [] };
  });

  // v4.5.1: the same pairing the Roster page proposes a swap for (every flex slot, receiver / RB-WR flex included), so a
  // "Flex lock order" variance always has its suggested swap. Both rows are red.
  const changing = new Set((league.lineup?.rows || []).map((r, i) => (r.changed && !r.locked ? i : -1)).filter((i) => i >= 0)); // slots a lineup change already uses
  for (const { flexIdx, posIdx } of flexTimingPairs(league, changing)) {
    const flex = league.starters[flexIdx];
    const positional = league.starters[posIdx];
    starterRows[flexIdx].issues.push(
      iss("Flex lock order", "major", `Locks ${flex.player.kickoffLabel} — before ${positional.slot} slot's ${positional.player.name} (${positional.player.kickoffLabel}). Swap these two.`)
    );
    starterRows[posIdx].issues.push(iss("Flex lock order", "major", `Later kickoff than ${flex.slot}'s ${flex.player.name} — swap these two to preserve flexibility.`));
  }

  // v2.9: Sleeper only lists players, so pad the bench with empty slots up to
  // the league's bench size (this is what makes "Open bench slot" appear).
  const benchList = [...(league.bench || [])];
  if (Number.isFinite(league.benchSlots)) while (benchList.length < league.benchSlots) benchList.push(null);
  // v2.9: an IR-eligible bench player is only worth flagging when there is an
  // open IR slot to move him into. Unknown IR size -> flag as before.
  const openIr = Number.isFinite(league.irSlots) ? league.irSlots - (league.ir || []).length : null;
  const benchRows = benchList.map((p) => {
    if (!p) return { slot: "BN", label: "(empty)", issues: [iss("Open bench slot", "minor", "Open bench slot — consider a waiver add")] };
    if (p.irEligible) {
      if (isLocked(p, league)) return { slot: "BN", label: p.name, issues: [], usage: p.usage }; // v3.4: locked — can't be moved to IR now
      if (openIr == null || openIr > 0) return { slot: "BN", label: p.name, issues: [iss("IR-eligible on bench", "minor", "IR-eligible — move to an empty IR slot")], usage: p.usage };
      return { slot: "BN", label: p.name, issues: [], note: "IR-eligible, but there is no open IR slot", usage: p.usage };
    }
    return { slot: "BN", label: p.name, issues: [], usage: p.usage };
  });
  // v3.1: a player who isn't IR-eligible in this league sitting in an IR slot is red from his game
  // day until his game ends (he can't be played from there and should be moved).
  const irRows = (league.ir || []).map((p) => {
    const bad = !p.irEligible && p.gameToday && p.gameState !== "post" && !isLocked(p, league); // v3.4: red only until kickoff (then he's locked)
    const issues = bad ? [iss("Non-IR-eligible player in IR slot", "major", `${p.name} is ${p.status || "healthy"} — not IR-eligible here, and his game is ${p.gameState === "in" ? "in progress" : "today"}. Move him out of the IR slot.`)] : [];
    return { slot: "IR", label: p.name, issues, severity: worst(issues.map((i) => i.severity)), reasons: issues.map((i) => i.text), reason: issues.map((i) => i.text).join(" ") || null, kickoffLabel: p.kickoffLabel };
  });
  const taxiRows = (league.taxi || []).map((p) => ({ slot: "TAXI", label: p.name, severity: "ok", reasons: [], kickoffLabel: p.kickoffLabel }));

  // Open bench slots share a label; number them so each is its own variance.
  let emptyBench = 0;
  benchRows.forEach((r) => {
    if (r.label === "(empty)") r.label = `(empty ${++emptyBench})`;
  });
  const rows = [...starterRows, ...benchRows].map((r) => ({
    ...r,
    severity: worst(r.issues.map((i) => i.severity)),
    reasons: r.issues.map((i) => i.text),
    reason: r.issues.map((i) => i.text).join(" ") || null,
  }));
  return { rows, irRows, taxiRows, status: worst([...rows, ...irRows].map((r) => r.severity)) };
}

// The Lineup tab's numbers, status and per-slot rows — including the user's
// own Player Rankings override when they've saved one. All the logic lives in
// lineup.js so it can be tested without React.
export function computeLineup(league) {
  return effectiveLineup(league);
}

// v2.9: waiver flags are by projection, not ECR or "trending":
//  - red:    a free agent projected higher than one of your current starters in
//            a slot he could fill (flex included) — you'd start him;
//  - yellow: a free agent projected higher than a bench player at his position.
// Trending is shown on the card but no longer flags anything.
// v3.9: the starter / bench comparison on its own, so every Available-page card (any category) gets it.
// v4.1: compared against the NEXT game only — a starter or bench player whose game has locked isn't a comparison,
// and neither is a free agent whose own game has started. A free agent with any designation other than Questionable
// (Out, Doubtful, IR, PUP, Suspended, …), Questionable and projected 0, or projected 0 on a bye week (v4.4.2), never "beats" anyone — for the starter rule
// and the bench rule alike (the waiver card note and the variance are the same thing).
const PLAYABLE_STATUS = new Set([null, undefined, "", "Healthy", "Questionable"]);
export function faCanCount(fa, league) {
  if (!fa) return false;
  if (!PLAYABLE_STATUS.has(fa.status)) return false;
  if (fa.status === "Questionable" && !(Number(fa.proj) > 0)) return false;
  // v4.4.2: a 0-point projection together with any injury designation or a bye week never beats anyone
  if (!(Number(fa.proj) > 0) && (fa.status === "Bye" || fa.onBye || (fa.status && fa.status !== "Healthy"))) return false;
  if (isLocked(fa, league)) return false;
  return true;
}
// v4.8: one of YOUR players on bye (projected 0) is never the player a free agent "beats".
export const onBye = (p) => Boolean(p) && (p.status === "Bye" || p.kickoffLabel === "On bye");
export function compareToRoster(league, fa) {
  const eligible = slotEligible;
  const projOf = (p) => (p && p.proj != null ? p.proj : 0);
  let rule = null;
  let note = null;
  let severity = "ok";
  if (fa.proj != null && faCanCount(fa, league)) {
    // v3.4: a locked starter can't be replaced this week, so he's not a comparison
    const slots = (league.starters || []).filter((s) => eligible(s.slot, fa.pos) && !isLocked(s.player, league) && !onBye(s.player));
    const weakest = slots.length ? slots.reduce((m, s) => (projOf(s.player) < projOf(m.player) ? s : m)) : null;
    if (weakest && fa.proj > projOf(weakest.player)) {
      rule = "Free agent outprojects a starter";
      severity = "major";
      note = `projected ${fa.proj.toFixed(1)} vs ${weakest.player ? weakest.player.name : "(empty)"} ${projOf(weakest.player).toFixed(1)} at ${weakest.slot}`;
    } else {
      const bench = (league.bench || []).filter((p) => p && p.pos === fa.pos && !isLocked(p, league) && !onBye(p)); // v3.4, v4.8: nor can a locked bench player be dropped
      // v4.6: dynasty leagues compare a free agent with the bench by dynasty (trade) value, not points. When the free agent
      // or every bench player at the position has no value, the comparison falls back to this week's projection.
      const byValue = league.leagueType === "dynasty" && fa.value != null && bench.some((p) => p.value != null);
      if (byValue) {
        const valued = bench.filter((p) => p.value != null);
        const weakBench = valued.reduce((m, p) => (p.value < m.value ? p : m));
        if (fa.value > weakBench.value) {
          rule = "Free agent outprojects a bench player";
          severity = "minor";
          note = `dynasty value ${Math.round(fa.value)} vs bench ${weakBench.name} ${Math.round(weakBench.value)}`;
        }
      } else {
        const weakBench = bench.length ? bench.reduce((m, p) => (projOf(p) < projOf(m) ? p : m)) : null;
        if (weakBench && fa.proj > projOf(weakBench)) {
          rule = "Free agent outprojects a bench player";
          severity = "minor";
          note = `projected ${fa.proj.toFixed(1)} vs bench ${weakBench.name} ${projOf(weakBench).toFixed(1)}`;
        }
      }
    }
  }
  return { rule, note, severity };
}

/**
 * v4.1: the other tracked leagues where this player can be claimed right now — not rostered there, his position is
 * used there, and his game hasn't locked there. Uses each league's `faSearch` (built by the server); an older build
 * without it falls back to that league's free-agent lists. Each entry carries the FAAB budget and what's left.
 */
export function availableElsewhere(fa, league, allLeagues = []) {
  if (!fa?.id) return [];
  const id = String(fa.id);
  return allLeagues
    .filter((l) => l && l.id !== league?.id && !l.error)
    .filter((l) => {
      const fs = l.faSearch;
      if (fs?.rosteredIds) {
        if (fs.rosteredIds.includes(id)) return false;
        if (fs.positions && !fs.positions.includes(fa.pos)) return false;
        if (fa.team && (fs.lockedTeams || []).includes(fa.team)) return false;
        return true;
      }
      return (l.freeAgents || []).some((x) => String(x.id) === id) || Boolean(l.waiverCategories?.cards?.[id]);
    })
    .map((l) => ({ id: l.id, name: l.name || l.id, faab: Boolean(l.waiverInfo?.faab), budget: l.waiverInfo?.budget || 0, remaining: l.waiverInfo?.remaining ?? Math.max(0, (l.waiverInfo?.budget || 0) - (l.waiverInfo?.used || 0)) }));
}

export function computeWaiver(league, allLeagues) {
  const rows = (league.freeAgents || []).map((fa) => {
    const { rule, note, severity } = compareToRoster(league, fa);
    const elsewhere = availableElsewhere(fa, league, allLeagues);
    return { ...fa, rule, note, severity, elsewhere, crossLeagues: elsewhere.map((l) => l.name) };
  });
  return { rows, status: worst(rows.map((r) => r.severity)) };
}

/**
 * v4.1: roster warnings for the Waivers screen.
 *  irMoves    players (starters or bench, not locked) who are IR-eligible here while an IR slot is empty
 *  over       { players, spots } when starters + bench hold more players than the starting + bench slots
 *  badIr      players sitting in an IR slot who aren't IR-eligible in this league any more
 *  ineligible true when either of the last two — claims may fail until it's fixed
 */
export function waiverRosterWarnings(league) {
  const starters = (league.starters || []).map((s) => s.player).filter(Boolean);
  const bench = (league.bench || []).filter(Boolean);
  const ir = (league.ir || []).filter(Boolean);
  const openIr = Number.isFinite(league.irSlots) ? Math.max(0, league.irSlots - ir.length) : 0;
  const irMoves = openIr > 0 ? [...starters, ...bench].filter((p) => p.irEligible && !isLocked(p, league)) : [];
  const spots = (league.starters || []).length + (Number.isFinite(league.benchSlots) ? league.benchSlots : bench.length);
  const players = starters.length + bench.length;
  const over = players > spots ? { players, spots } : null;
  const badIr = ir.filter((p) => !p.irEligible);
  return { irMoves, openIr, over, badIr, ineligible: Boolean(over || badIr.length) };
}

// v2.9: a big-gap opportunity is yellow and clears itself once the page has
// been viewed and left; a smaller one is listed but is not a variance.
export function computeTrade(league) {
  const rows = (league.tradeSuggestions || []).map((t) => {
    const big = t.severity === "major";
    return { ...t, bigGap: big, severity: big ? "minor" : "ok", auto: big };
  });
  return { rows, status: worst(rows.map((t) => t.severity)) };
}

// Injury Watch now persists: every currently-injured player shows up
// every time, Minor once you've seen that exact status before, Major
// the first time. Rows come pre-computed this way from the server
// (db.js tracks "seen" per player+status in SQLite) — this just derives
// the tab's overall status from what the server already decided.
export function computeInjury(league) {
  const rows = league.injuryEvents || [];
  const status = rows.some((r) => !r.seen) ? "major" : "ok"; // v4.4.2: a status seen before is listed but no longer yellow
  return { rows, status };
}

/**
 * v4.8: roster compliance for Waivers → Drop candidates.
 *   badIr         — players in an IR slot who are not IR-eligible (move out → bench)
 *   inCandidates  — IR-eligible starters/bench players who are not on IR (move in), only while an IR slot is free
 *   Selections: outIds / inIds (arrays of ids). The roster-limit maths follows them live:
 *   moving a player OUT of IR adds a roster spot used; moving one IN frees a spot.
 * Returns { badIr, inCandidates, irSlots, irOpenAfterOuts, spots, players, over, dropsNeeded, dropList, issues }.
 * dropList = the 5 lowest-rostered droppable bench players (not locked, not moving to IR), lowest first.
 */
export function rosterCompliance(league, { outIds = null, inIds = null } = {}) {
  const starters = (league.starters || []).map((s) => s.player).filter(Boolean);
  const bench = (league.bench || []).filter(Boolean);
  const ir = (league.ir || []).filter(Boolean);
  const irSlots = Number.isFinite(league.irSlots) ? league.irSlots : 0;
  const badIr = ir.filter((p) => !p.irEligible);
  const outSel = new Set((outIds ?? badIr.map((p) => String(p.id))).map(String));
  const irOpenAfterOuts = Math.max(0, irSlots - ir.length + badIr.filter((p) => outSel.has(String(p.id))).length);
  const inCandidates = irSlots - ir.length + badIr.length > 0 ? [...starters, ...bench].filter((p) => p.irEligible && !isLocked(p, league)) : [];
  const inSel = new Set((inIds ?? inCandidates.slice(0, irOpenAfterOuts).map((p) => String(p.id))).map(String));
  const movingIn = inCandidates.filter((p) => inSel.has(String(p.id))).length;
  const spots = starters.length + (Number.isFinite(league.benchSlots) ? league.benchSlots : bench.length);
  const outCount = badIr.filter((p) => outSel.has(String(p.id))).length;
  const players = starters.length + bench.length + outCount - movingIn;
  const over = Math.max(0, players - spots);
  const rawPlayers = starters.length + bench.length;
  const dropList = bench
    .filter((p) => !isLocked(p, league) && !inSel.has(String(p.id)))
    .sort((a, b) => (a.rostered ?? 101) - (b.rostered ?? 101) || (a.proj ?? 0) - (b.proj ?? 0))
    .slice(0, 5);
  const issues = [];
  if (badIr.length) issues.push(`${badIr.length} player${badIr.length === 1 ? " is" : "s are"} in IR but not eligible`);
  if (inCandidates.length) issues.push(`${inCandidates.length} IR-eligible player${inCandidates.length === 1 ? " is" : "s are"} not on IR`);
  if (rawPlayers > spots) issues.push(`roster over the limit by ${rawPlayers - spots}`);
  return { badIr, inCandidates, inSelDefault: inCandidates.slice(0, irOpenAfterOuts).map((p) => String(p.id)), irSlots, irOpenAfterOuts, spots, players, over, dropsNeeded: over, dropList, issues, rawOver: Math.max(0, rawPlayers - spots) };
}

/* ------------------------------------------------------------------ */
/*  v4.9: the roster rules re-run on the lineup after the ticked moves  */
/* ------------------------------------------------------------------ */
/**
 * The Proposed lineup's variances: computeRoster() on the roster as it would stand (`leagueAfter` result), with the ones
 * already cleared on the real lineup (same league / week / rule / row) kept quiet. Returns { lg, rows, irRows } where
 * rows = starters then bench (same order as the arrangement) and irRows follow the arrangement's IR list.
 */
export function computeProposedRoster(league, after) {
  const r = computeRoster(after);
  const cleared = new Set((league?.variances || []).filter((v) => v.cleared).map((v) => `${v.key}|${v.severity}`));
  const keyOf = (row, issue) => [league.id, `W${league.week ?? "?"}`, "roster", issue.rule, `${row.slot} ${row.label}`].join("|") + `|${issue.severity}`;
  const settle = (rows) =>
    rows.map((row) => {
      const issues = (row.issues || []).map((i) => ({ ...i, cleared: cleared.has(keyOf(row, i)) }));
      const open = issues.filter((i) => !i.cleared);
      return { ...row, issues, severity: worst(open.map((i) => i.severity)), reason: open.map((i) => i.text).join(" ") || null };
    });
  return { lg: after, rows: settle(r.rows), irRows: settle(r.irRows) };
}
