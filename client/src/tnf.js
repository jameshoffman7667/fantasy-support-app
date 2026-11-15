// v4.11 — Game Day → TNF: your players who play Thursday night, in every league, plus (per league) the three lowest
// projected starters and the three highest projected bench / IR / taxi players, leaving the Thursday players out.
// Pure (no React).
import { isLocked } from "./lineup.js";

const ET = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", hourCycle: "h23" });

/** A Thursday kickoff at 7 pm Eastern or later (the Sunday-night rule, on Thursday). */
export function isThursdayNight(kickoff) {
  if (kickoff == null || !Number.isFinite(Number(kickoff))) return false;
  const parts = Object.fromEntries(ET.formatToParts(new Date(Number(kickoff))).map((p) => [p.type, p.value]));
  return parts.weekday === "Thu" && Number(parts.hour) >= 19;
}

const num = (x) => (x == null || x === "" || !Number.isFinite(Number(x)) ? null : Number(x));

/**
 * One league: { thursday: [{ player, slot, group }], lowStarters: [...3], highReserve: [...3] }.
 * `slot` is the position box label: the starting slot (QB, RB, FLEX …), BN, IR or TAXI.
 */
export function tnfForLeague(league) {
  const rows = [];
  (league?.starters || []).forEach((s) => s?.player && rows.push({ player: s.player, slot: s.slot, group: "starter" }));
  (league?.bench || []).forEach((p) => p && rows.push({ player: p, slot: "BN", group: "bench" }));
  (league?.ir || []).forEach((p) => p && rows.push({ player: p, slot: "IR", group: "ir" }));
  (league?.taxi || []).forEach((p) => p && rows.push({ player: p, slot: "TAXI", group: "taxi" }));
  const thursday = rows.filter((r) => isThursdayNight(r.player.kickoff));
  const ids = new Set(thursday.map((r) => String(r.player.id ?? r.player.name)));
  const rest = rows.filter((r) => !ids.has(String(r.player.id ?? r.player.name)) && num(r.player.proj) != null);
  const byProj = (a, b) => num(a.player.proj) - num(b.player.proj) || String(a.player.name).localeCompare(String(b.player.name));
  const lowStarters = rest.filter((r) => r.group === "starter").sort(byProj).slice(0, 3);
  const highReserve = rest.filter((r) => r.group !== "starter").sort((a, b) => byProj(b, a)).slice(0, 3);
  // Thursday players: starters first (in lineup order), then bench, IR, taxi; best projection first inside a group
  const order = { starter: 0, bench: 1, ir: 2, taxi: 3 };
  const thursdaySorted = thursday
    .map((r, i) => ({ r, i }))
    .sort((a, b) => order[a.r.group] - order[b.r.group] || (a.r.group === "starter" ? a.i - b.i : (num(b.r.player.proj) ?? -1e9) - (num(a.r.player.proj) ?? -1e9)))
    .map((x) => x.r);
  return { thursday: thursdaySorted, lowStarters, highReserve };
}

/** All leagues (errored ones skipped). `only` = a Set of league ids to limit to, or empty for all. */
export function tnfView(leagues, only = null) {
  return (leagues || [])
    .filter((l) => l && !l.error && (l.starters || l.bench) && (!only || only.size === 0 || only.has(l.id)))
    .map((l) => ({ id: l.id, name: l.name, avatar: l.avatar, ...tnfForLeague(l) }));
}

export const fmtProj = (x) => (num(x) == null ? "—" : num(x).toFixed(1));
/** "A (RB, 4.2), B (FLEX, 5.0)" */
export function listText(rows) {
  return rows.map((r) => `${r.player.name} (${r.slot}, ${fmtProj(r.player.proj)})`).join(", ");
}

/**
 * v4.20.0 (P-40): red / green on the lists under each league. A "lowest projected starter" is RED when his projection is below
 * a Thursday-night BENCH player's (that bench player could take his place); a "highest projected bench / IR / taxi" player is
 * GREEN when his projection is above a Thursday-night STARTER's. Same league, projection as shown; a player whose game has
 * started is never coloured, and a locked Thursday player is not a swap target. Returns the two lists with `tone`.
 */
export function tnfTones(entry, league) {
  const locked = (p) => isLocked(p, league);
  const tnfBench = entry.thursday.filter((r) => r.group === "bench" && !locked(r.player) && num(r.player.proj) != null);
  const tnfStart = entry.thursday.filter((r) => r.group === "starter" && !locked(r.player) && num(r.player.proj) != null);
  const lowStarters = entry.lowStarters.map((r) => ({ ...r, tone: !locked(r.player) && tnfBench.some((b) => num(b.player.proj) > num(r.player.proj)) ? "red" : null }));
  const highReserve = entry.highReserve.map((r) => ({ ...r, tone: !locked(r.player) && tnfStart.some((st) => num(r.player.proj) > num(st.player.proj)) ? "green" : null }));
  return { lowStarters, highReserve };
}

/**
 * v4.20.0 (P-40): the tab Game Day opens on, by the Eastern-time clock. TNF from Tuesday 3:00 am until Friday 3:00 am; then the
 * Cheer meter until Sunday after the last 4 pm games are done; then Primetime until Tuesday 3:00 am. `stage` is the server's
 * Primetime stage ("waiting" until the last afternoon game ends, then "sunday" / "monday"); null when unknown, and then
 * Sunday 8 pm Eastern stands in for "the 4 pm games are done".
 */
const ET_CLOCK = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" });
export function defaultGameDayTab(now = Date.now(), stage = null) {
  const p = Object.fromEntries(ET_CLOCK.formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  const mins = Number(p.hour) * 60 + Number(p.minute);
  const after3 = mins >= 180;
  if (day === 2 && after3) return "tnf"; // Tue 3 am ->
  if (day === 3 || day === 4) return "tnf"; // Wed, Thu
  if (day === 5 && !after3) return "tnf"; // -> Fri 3 am
  if (day === 1 || (day === 2 && !after3)) return "primetime"; // Mon, Tue before 3 am
  if (day === 0) { // Sunday: the Cheer meter until the afternoon games are done
    const done = stage ? stage !== "waiting" : mins >= 20 * 60;
    return done ? "primetime" : "cheer";
  }
  return "cheer"; // Fri 3 am -> Sat -> Sunday morning
}
