// v4.8: a claim identical to one already queued in Sleeper, or just sent (same player, drop and bid), is refused so a
// double tap / a stale page can't file it twice. The memory is cleared when that claim is cancelled.
const RECENT_CLAIM_MS = 15 * 60 * 1000;
const recentClaims = new Map(); // `${user}|${league}|${add}|${drop}|${bid}` -> sent-at
const claimMemKey = (u, l, add, drop, bid) => `${u}|${l}|${add}|${drop || ""}|${Number(bid) || 0}`;
export function duplicateClaim(username, lg, { addId, dropId, bid }, now = Date.now()) {
  for (const [k, at] of recentClaims) if (now - at > RECENT_CLAIM_MS) recentClaims.delete(k);
  if (recentClaims.has(claimMemKey(username, lg.id, addId, dropId, bid))) return true;
  const pend = lg.privateInfo?.claims?.pending || [];
  return pend.some((x) => String(x.adds?.[0] ?? "") === String(addId) && String(x.drops?.[0] ?? "") === String(dropId || "") && (Number(x.bid) || 0) === (Number(bid) || 0));
}
export function rememberClaim(username, lg, c, now = Date.now()) { recentClaims.set(claimMemKey(username, lg.id, c.addId, c.dropId, c.bid), now); }
export function forgetClaim(username, lg, c) { recentClaims.delete(claimMemKey(username, lg.id, c.addId, c.dropId, c.bid)); }
export function _clearForTests() { recentClaims.clear(); }
