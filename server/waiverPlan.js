import * as store from "./projectionStore.js";

/**
 * v2.9: the waiver plan a user builds on the Waivers / Claims pages, saved per
 * user per league in app_state (`waiver_plan:{user}:{league}`) so it follows
 * them across devices. The server only validates and stores it; all the claim
 * maths (claim generation, ordering, budget simulation) is the pure module
 * client/src/waiverPlan.js, which the tests exercise directly.
 *
 * Shape:
 *  entryMode  "dollars" | "percent" — how bid boxes are typed (bids are always stored in dollars)
 *  drops      [{id,name,pos,willing}] bench players ranked most-willing-to-drop first
 *  bids       [{id,name,pos,bid}] waiver targets with a bid (0 counts); order = order entered
 *  edits      { [claimKey]: {bid?, dropId?, dropName?} } hand edits to generated claims
 *  removed    [claimKey] generated claims the user deleted
 *  custom     [{key,addId,addName,pos,bid,dropId,dropName}] claims the user added by hand
 *  order      [claimKey] saved order within each bid group (drag handle)
 */
const k = (username, leagueId) => `waiver_plan:${username}:${leagueId}`;
const str = (v, n = 80) => String(v ?? "").slice(0, n);
const num = (v, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? Math.min(max, Math.round(n)) : null; // negatives are invalid, not clamped
};

export function emptyPlan() {
  return { entryMode: "dollars", drops: [], bids: [], edits: {}, removed: [], custom: [], order: [], updatedAt: null };
}

export function sanitize(input) {
  const p = input && typeof input === "object" ? input : {};
  const out = emptyPlan();
  out.entryMode = p.entryMode === "percent" ? "percent" : "dollars";
  out.drops = (Array.isArray(p.drops) ? p.drops : []).slice(0, 60).filter((d) => d && d.id != null).map((d) => ({ id: str(d.id, 40), name: str(d.name), pos: str(d.pos, 6), willing: Boolean(d.willing) }));
  const seen = new Set();
  out.bids = (Array.isArray(p.bids) ? p.bids : [])
    .slice(0, 200)
    .filter((b) => b && b.id != null)
    .map((b) => ({ id: str(b.id, 40), name: str(b.name), pos: str(b.pos, 6), bid: num(b.bid, 0, 1e6) }))
    .filter((b) => b.bid != null && !seen.has(b.id) && seen.add(b.id));
  out.edits = {};
  for (const [key, e] of Object.entries(p.edits && typeof p.edits === "object" ? p.edits : {}).slice(0, 500)) {
    if (!e || typeof e !== "object") continue;
    const ed = {};
    if (e.bid != null && num(e.bid, 0, 1e6) != null) ed.bid = num(e.bid, 0, 1e6);
    if ("dropId" in e) {
      ed.dropId = e.dropId == null || e.dropId === "" ? null : str(e.dropId, 40);
      ed.dropName = ed.dropId ? str(e.dropName) : null;
    }
    if (Object.keys(ed).length) out.edits[str(key, 100)] = ed;
  }
  out.removed = (Array.isArray(p.removed) ? p.removed : []).slice(0, 500).map((x) => str(x, 100));
  out.custom = (Array.isArray(p.custom) ? p.custom : [])
    .slice(0, 100)
    .filter((c) => c && c.addId != null && num(c.bid, 0, 1e6) != null)
    .map((c, i) => ({ key: str(c.key || `c:${i}:${c.addId}`, 100), addId: str(c.addId, 40), addName: str(c.addName), pos: str(c.pos, 6), bid: num(c.bid, 0, 1e6), dropId: c.dropId == null || c.dropId === "" ? null : str(c.dropId, 40), dropName: c.dropId ? str(c.dropName) : null }));
  out.order = (Array.isArray(p.order) ? p.order : []).slice(0, 1000).map((x) => str(x, 100));
  return out;
}

export function getPlan(username, leagueId) {
  const saved = store.getState(k(username, leagueId), null);
  return saved ? { ...sanitize(saved), updatedAt: saved.updatedAt ?? null } : emptyPlan();
}

export function savePlan(username, leagueId, input) {
  const plan = { ...sanitize(input), updatedAt: Date.now() };
  store.setState(k(username, leagueId), plan);
  return plan;
}
