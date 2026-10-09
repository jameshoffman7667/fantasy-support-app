import * as store from "./projectionStore.js";

/**
 * v4.4.1 — "add this player, then make the matching lineup move".
 *
 * A Roster suggestion that starts a free agent / waiver player is ticked on the Proposed lineup. The app sends the add
 * to Sleeper as a claim (with the drop and, on waivers, the FAAB bid) and stores a PENDING LINEUP MOVE here. A check
 * every 5 minutes (scheduler.pendingMovesTick) looks at your roster; once the player is on it, the lineup move is sent.
 * Nothing is sent before the player is on the roster, and a move that no longer fits (slot changed, game started, claim
 * lost) is dropped and you are told. Uses the Sleeper token's "Waiver claims" and "Roster changes" switches.
 *
 * Unverified against live Sleeper: whether a free agent can be added through a claim and lands at once, or only at the
 * next waiver run — either way the move waits until the player shows up on the roster.
 */
const KEY = (u) => `pendingmoves:${u}`;
const HOUR = 3600e3;
export const GIVE_UP_AFTER_RUN_MS = 12 * HOUR;
export const CHECK_EVERY_MS = 5 * 60 * 1000;
const LOG_KEY = (u) => `pendingmoves:log:${u}`;

export const list = (username, leagueId = null) => (store.getState(KEY(username), null) || []).filter((m) => leagueId == null || String(m.leagueId) === String(leagueId));
const save = (username, moves) => store.setState(KEY(username), moves);
export const getLog = (username, leagueId = null) => (store.getState(LOG_KEY(username), null) || []).filter((e) => leagueId == null || String(e.leagueId) === String(leagueId));
function log(username, entry, now = Date.now()) {
  const l = store.getState(LOG_KEY(username), null) || [];
  l.unshift({ at: now, ...entry });
  store.setState(LOG_KEY(username), l.slice(0, 30));
}

export function add(username, move, now = Date.now()) {
  const m = { id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, createdAt: now, ...move };
  save(username, [...list(username), m]);
  return m;
}
export function remove(username, id) {
  const all = list(username);
  save(username, all.filter((m) => m.id !== id));
  return all.find((m) => m.id === id) || null;
}

const lockedNow = (p, built, now) => Boolean(p && !built.weekOver && (p.started || p.played || (p.kickoff != null && p.kickoff <= now)));

/** Every player id on the roster, by place. */
export function rosterIds(built) {
  const s = (a) => (a || []).filter(Boolean).map((p) => String(p.id ?? p));
  return { starters: (built.starterIds || []).map(String).filter((x) => x !== "0"), bench: s(built.bench), ir: s(built.ir), taxi: s(built.taxi) };
}

/** Can this drop be asked for? Returns an error string or null. Pure. */
export function checkAdd(built, { addId, dropId, slotIndex, fromId, now = Date.now() }) {
  if (!built || built.error) return "That league isn't loaded — refresh and try again.";
  const ids = rosterIds(built);
  const all = new Set([...ids.starters, ...ids.bench, ...ids.ir, ...ids.taxi]);
  if (all.has(String(addId))) return "He is already on your roster.";
  const cur = String((built.starterIds || [])[slotIndex] ?? "0");
  const want = fromId == null ? "0" : String(fromId);
  if (slotIndex == null || slotIndex < 0 || slotIndex >= (built.starterIds || []).length || cur !== want) return "Your lineup changed since this suggestion — refresh and try again.";
  if (dropId != null && dropId !== "") {
    if (!all.has(String(dropId))) return "The player to drop isn't on your roster.";
    const dp = [...(built.bench || []), ...(built.ir || []), ...(built.taxi || []), ...(built.starters || []).map((s) => s.player)].filter(Boolean).find((p) => String(p.id) === String(dropId));
    if (dp && lockedNow(dp, built, now)) return `${dp.name} is locked (his game has started) and can't be dropped.`;
    if (ids.starters.includes(String(dropId)) && String(dropId) !== String(want)) return "Only the player being replaced can be dropped from the starting lineup.";
  } else if (Number.isFinite(Number(built.benchSlots)) && ids.bench.length >= Number(built.benchSlots) && !(ids.starters.includes("0"))) {
    return "Your roster is full — choose a player to drop.";
  }
  return null;
}

/** What to do for a waiting move, given a fresh build of the league. Pure. → {action:"wait"|"done"|"push"|"cancel", ...} */
export function planLineup(built, move, now = Date.now()) {
  const ids = rosterIds(built);
  const on = [...ids.starters, ...ids.bench, ...ids.ir, ...ids.taxi].includes(String(move.addId));
  if (!on) return { action: "wait" };
  const starters = (built.starterIds || []).map(String);
  if (starters.includes(String(move.addId))) return { action: "done", reason: `${move.addName} is already in your lineup.` };
  if (!ids.bench.includes(String(move.addId))) return { action: "cancel", reason: `${move.addName} is on your ${ids.ir.includes(String(move.addId)) ? "IR" : "taxi squad"}, not the bench, so he can't be started.` };
  const i = move.slotIndex;
  const want = move.fromId == null ? "0" : String(move.fromId);
  const cur = starters[i] ?? null;
  const droppedStarter = move.dropId != null && String(move.dropId) === want;
  if (cur == null || !(cur === want || (droppedStarter && (cur === "0" || cur === "")))) return { action: "cancel", reason: `your ${move.slot} slot has changed since you asked.` };
  const p = (built.bench || []).filter(Boolean).find((x) => String(x.id) === String(move.addId));
  if (lockedNow(p, built, now)) return { action: "cancel", reason: `${move.addName}'s game has already started.` };
  const out = (built.starters || []).map((s) => s.player).filter(Boolean).find((x) => String(x.id) === want);
  if (out && lockedNow(out, built, now)) return { action: "cancel", reason: `${out.name}'s game has already started, so ${move.slot} is locked.` };
  const next = [...starters];
  next[i] = String(move.addId);
  return { action: "push", starters: next };
}

function perms(deps, username) {
  try { return deps.priv.status(username).perms || {}; } catch { return {}; }
}

/**
 * One pass over a user's waiting moves. deps: { priv, rosterPlayerIds(leagueId, rosterId) → ids[], build(leagueId) → built,
 * notify(username, title, body) }. Returns what happened.
 */
export async function runPending(username, deps, now = Date.now()) {
  const out = [];
  for (const m of list(username)) {
    if (now < (m.checkFrom || 0)) continue;
    const finish = (status, detail) => {
      remove(username, m.id);
      log(username, { leagueId: m.leagueId, leagueName: m.leagueName, player: m.addName, slot: m.slot, status, detail }, now);
      out.push({ id: m.id, status, detail });
      deps.notify?.(username, `${m.leagueName}: ${m.addName}`, status === "done" ? detail : `Lineup move not made — ${detail}`);
    };
    try {
      const ids = (await deps.rosterPlayerIds(m.leagueId, m.rosterId)).map(String);
      if (!ids.includes(String(m.addId))) {
        if (now > m.expires) finish("cancelled", `${m.addName} never showed up on your roster (the claim may have lost or failed). Your lineup was left as it was.`);
        continue;
      }
      if (!perms(deps, username).roster) {
        if (now > m.expires) finish("cancelled", `${m.addName} is on your roster, but "Roster changes" is switched off in Account → Sleeper access.`);
        continue;
      }
      const built = await deps.build(m.leagueId);
      const plan = planLineup(built, m, now);
      if (plan.action === "wait") continue; // the build hasn't caught up with the roster yet
      if (plan.action === "done") { finish("done", plan.reason); continue; }
      if (plan.action === "cancel") { finish("cancelled", plan.reason); continue; }
      const r = await deps.priv.updateStarters(username, { leagueId: m.leagueId, rosterId: m.rosterId, round: Number(built.week), starters: plan.starters, confirm: true });
      if (r?.ok) finish("done", `${m.addName} is now starting at ${m.slot}${r.verified === false ? " (sent, not verified — check Sleeper)" : ""}.`);
      else finish("cancelled", r?.detail || "Sleeper didn't accept the lineup change.");
    } catch (e) {
      if (now > m.expires) finish("cancelled", e.message);
    }
  }
  return out;
}
