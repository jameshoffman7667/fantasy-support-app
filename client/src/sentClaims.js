// v4.8: claims just pushed are remembered locally (per league) until Sleeper's pending list catches up, so the
// "Push to Sleeper" button goes away at once and the same claim can't be sent twice. Cancelling forgets it.
const SENT_MS = 15 * 60 * 1000;
const sentClaims = new Map(); // leagueId -> Map(`${add}|${drop}|${bid}` -> at)
const sentKey = (c) => `${c.addId}|${c.dropId || ""}|${Number(c.bid) || 0}`;
export function markSent(leagueId, c, at = Date.now()) {
  if (!sentClaims.has(String(leagueId))) sentClaims.set(String(leagueId), new Map());
  sentClaims.get(String(leagueId)).set(sentKey(c), at);
}
export function forgetSent(leagueId, c) { sentClaims.get(String(leagueId))?.delete(sentKey(c)); }
export function isSent(leagueId, c, now = Date.now()) {
  const m = sentClaims.get(String(leagueId));
  const at = m?.get(sentKey(c));
  if (at == null) return false;
  if (now - at > SENT_MS) { m.delete(sentKey(c)); return false; }
  return true;
}
export function clearSentForTest() { sentClaims.clear(); }

