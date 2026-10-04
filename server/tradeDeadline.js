/**
 * Trade-deadline helper.
 *
 * Sleeper's league settings expose `trade_deadline` as a week number only.
 * UNVERIFIED: what 0 or large values (e.g. 99) mean is not documented; we
 * treat <= 0 or >= 19 (no regular-season week 19+) as "no deadline".
 * The real cut-off *time* is not in the API at all, so `endsAt` is an
 * estimate: last kickoff in that NFL week + 4 hours (about game length).
 * Sleeper might lock trades at the start of the week, on a specific day,
 * or at the end -- we have no way to confirm from here.
 */

const FOUR_HOURS = 4 * 3600e3;

function fmtSpan(ms) {
  const abs = Math.abs(ms);
  const days = Math.floor(abs / 86400e3);
  if (days >= 2) return `${days} days`;
  const hours = Math.max(1, Math.round(abs / 3600e3));
  return hours >= 48 ? `${Math.round(hours / 24)} days` : `${hours} hour${hours === 1 ? "" : "s"}`;
}

export async function deadlineInfo({ settings, currentWeek, season, now = Date.now(), getWeekSchedule } = {}) {
  const raw = Number(settings?.trade_deadline);
  const NOTE = "Sleeper's API only gives a week number for the trade deadline, so the exact cut-off time is an estimate (end of that week's last game, +4h) and unverified. Check the league's own settings for the real time.";
  if (!Number.isFinite(raw) || raw <= 0 || raw >= 19) {
    return {
      configured: false, week: null, weeksLeft: null, passed: false, endsAt: null,
      label: "No trade deadline set",
      note: "Sleeper reports trade_deadline <= 0 or >= 19 (or missing); we assume that means no deadline, but Sleeper doesn't document those values.",
    };
  }
  const week = Math.floor(raw);
  let endsAt = null;
  try {
    const sched = getWeekSchedule ? await getWeekSchedule(season, week) : null;
    const times = Object.values(sched?.byTeam || {}).map((g) => g?.kickoffMillis).filter((n) => Number.isFinite(n));
    if (times.length) endsAt = Math.max(...times) + FOUR_HOURS;
  } catch {
    endsAt = null;
  }
  const weeksLeft = Math.max(0, week - (Number(currentWeek) || 0));
  const passed = endsAt != null ? now > endsAt : (Number(currentWeek) || 0) > week;
  let label;
  if (passed) label = `Trade deadline passed (end of Week ${week})`;
  else if (endsAt != null) label = `Trade deadline: end of Week ${week} (about ${fmtSpan(endsAt - now)})`;
  else label = `Trade deadline: end of Week ${week} (${weeksLeft} week${weeksLeft === 1 ? "" : "s"} left)`;
  return { configured: true, week, weeksLeft, passed, endsAt, label, note: NOTE };
}
