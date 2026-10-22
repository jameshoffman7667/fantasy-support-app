// v4.11 — Game Day → TNF: your players who play Thursday night, in every league, plus (per league) the three lowest
// projected starters and the three highest projected bench / IR / taxi players, leaving the Thursday players out.
// Pure (no React).

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
