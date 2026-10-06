/**
 * Trade-deadline helper.
 *
 * Sleeper's league settings give `trade_deadline` as a week number. v3.5 (James's rule): the deadline is always
 * the end of the last game of that week. The countdown runs to that game's kickoff + 3.5 hours (about a game's
 * length); once ESPN marks that game final the deadline has passed. <= 0 or >= 19 means no deadline.
 */
const GAME_LENGTH_MS = 3.5 * 3600e3;

function fmtSpan(ms) {
  const abs = Math.abs(ms);
  const days = Math.floor(abs / 86400e3);
  if (days >= 2) return `${days} days`;
  const hours = Math.max(1, Math.round(abs / 3600e3));
  return hours >= 48 ? `${Math.round(hours / 24)} days` : `${hours} hour${hours === 1 ? "" : "s"}`;
}

const dayName = (ms) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long" }).format(new Date(ms));

export async function deadlineInfo({ settings, currentWeek, season, now = Date.now(), getWeekSchedule } = {}) {
  const raw = Number(settings?.trade_deadline);
  if (!Number.isFinite(raw) || raw <= 0 || raw >= 19) {
    return { configured: false, week: null, weeksLeft: null, passed: false, endsAt: null, label: "No trade deadline set", note: null };
  }
  const week = Math.floor(raw);
  let endsAt = null;
  let lastGameFinal = false;
  let lastDay = null;
  try {
    const sched = getWeekSchedule ? await getWeekSchedule(season, week) : null;
    const games = (sched?.games || []).filter((g) => Number.isFinite(g?.kickoffMillis));
    if (games.length) {
      const last = games.reduce((a, b) => (b.kickoffMillis > a.kickoffMillis ? b : a));
      endsAt = last.kickoffMillis + GAME_LENGTH_MS;
      lastGameFinal = last.state === "post";
      lastDay = dayName(last.kickoffMillis);
    } else {
      const times = Object.values(sched?.byTeam || {}).map((g) => g?.kickoffMillis).filter((n) => Number.isFinite(n));
      if (times.length) {
        const lastKick = Math.max(...times);
        endsAt = lastKick + GAME_LENGTH_MS;
        lastDay = dayName(lastKick);
      }
    }
  } catch {
    endsAt = null;
  }
  const weeksLeft = Math.max(0, week - (Number(currentWeek) || 0));
  const passed = lastGameFinal || (endsAt != null ? now > endsAt : (Number(currentWeek) || 0) > week);
  let label;
  const when = lastDay ? `end of Week ${week}'s last game (${lastDay})` : `end of Week ${week}`;
  if (passed) label = `Trade deadline passed (${when})`;
  else if (endsAt != null) label = `Trade deadline: ${when}, in about ${fmtSpan(endsAt - now)}`;
  else label = `Trade deadline: ${when} (${weeksLeft} week${weeksLeft === 1 ? "" : "s"} left)`;
  // `when` is the banner's second line ("End of Week 11's last game (Monday)") under the countdown.
  return { configured: true, week, weeksLeft, passed, endsAt, label, when: when.charAt(0).toUpperCase() + when.slice(1), note: null };
}
