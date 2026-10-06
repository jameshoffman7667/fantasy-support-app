import { effectiveLineup, hasStarted, isLocked } from "../lineup.js";
import { worst } from "./theme.js";

/* ------------------------------------------------------------------ */
/*  VARIANCE CALCULATIONS                                             */
/* ------------------------------------------------------------------ */
const FLEX_ELIGIBLE = { FLEX: ["RB", "WR", "TE"], SFLX: ["QB", "RB", "WR", "TE"] };

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

  league.starters.forEach(({ slot, player: flexPlayer }, idx) => {
    if (!FLEX_ELIGIBLE[slot] || !flexPlayer || flexPlayer.kickoff == null) return;
    if (isLocked(flexPlayer, league)) return; // v3.4: already locked — the swap can't be made
    const posIdx = league.starters.findIndex(
      (s) => s.slot === flexPlayer.pos && s.player && s.player.kickoff != null && s.player.kickoff > flexPlayer.kickoff
    );
    if (posIdx < 0) return;
    const positional = league.starters[posIdx];
    if (isLocked(positional.player, league)) return;
    starterRows[idx].issues.push(
      iss("Flex lock order", "major", `Locks ${flexPlayer.kickoffLabel} — before ${positional.slot} slot's ${positional.player.name} (${positional.player.kickoffLabel}). Swap these two.`)
    );
    starterRows[posIdx].issues.push(iss("Flex lock order", "major", `Later kickoff than ${slot}'s ${flexPlayer.name} — swap these two to preserve flexibility.`));
  });

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
export function computeWaiver(league, allLeagues) {
  const eligible = (slot, pos) => (FLEX_ELIGIBLE[slot] ? FLEX_ELIGIBLE[slot].includes(pos) : slot === pos);
  const projOf = (p) => (p && p.proj != null ? p.proj : 0);
  const rows = (league.freeAgents || []).map((fa) => {
    let rule = null;
    let note = null;
    let severity = "ok";
    if (fa.proj != null) {
      // v3.4: a locked starter can't be replaced this week, so he's not a comparison
      const slots = (league.starters || []).filter((s) => eligible(s.slot, fa.pos) && !isLocked(s.player, league));
      const weakest = slots.length ? slots.reduce((m, s) => (projOf(s.player) < projOf(m.player) ? s : m)) : null;
      if (weakest && fa.proj > projOf(weakest.player)) {
        rule = "Free agent outprojects a starter";
        severity = "major";
        note = `projected ${fa.proj.toFixed(1)} vs ${weakest.player ? weakest.player.name : "(empty)"} ${projOf(weakest.player).toFixed(1)} at ${weakest.slot}`;
      } else {
        const bench = (league.bench || []).filter((p) => p && p.pos === fa.pos && !isLocked(p, league)); // v3.4: nor can a locked bench player be dropped
        const weakBench = bench.length ? bench.reduce((m, p) => (projOf(p) < projOf(m) ? p : m)) : null;
        if (weakBench && fa.proj > projOf(weakBench)) {
          rule = "Free agent outprojects a bench player";
          severity = "minor";
          note = `projected ${fa.proj.toFixed(1)} vs bench ${weakBench.name} ${projOf(weakBench).toFixed(1)}`;
        }
      }
    }
    const crossLeagues = allLeagues
      .filter((l) => l.id !== league.id && !l.error)
      .filter((l) => (l.freeAgents || []).some((x) => x.id === fa.id || x.name === fa.name))
      .map((l) => l.name);
    return { ...fa, rule, note, severity, crossLeagues };
  });
  return { rows, status: worst(rows.map((r) => r.severity)) };
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
  const status = rows.length === 0 ? "ok" : rows.some((r) => !r.seen) ? "major" : "minor";
  return { rows, status };
}
