// v4.17 (P-32): compare the freshly generated claims with the claims already queued in Sleeper — pure, unit-tested.
// The proposed claims are always built from the Available bids and the Drop candidates alone (existing claims are
// ignored while generating); only afterwards are they compared with what is queued.
//
// Per proposed claim:
//  - same:     same add, same drop, same bid -> unticked + greyed by default, can still be reordered
//  - bid:      same add + same drop, different bid -> note "existing bid will be updated" (cancel + re-push)
//  - drop:     same add, queued claim drops someone no proposed claim for that add drops -> note "existing claim will be updated"
//  - sameDrop: (extra note) a queued claim for ANOTHER player drops the same player
// Sleeper has no edit or reorder call, so every update is: cancel the queued claim, then push the new one.

const dk = (id) => (id == null || id === "" ? "-" : String(id));

export function compareClaims(proposed = [], existing = [], nameOf = (id) => ({ name: String(id) })) {
  const byAdd = new Map();
  for (const x of existing) {
    const k = String(x.addId);
    if (!byAdd.has(k)) byAdd.set(k, []);
    byAdd.get(k).push(x);
  }
  const proposedDrops = new Map(); // addId -> Set(drop keys)
  for (const c of proposed) {
    const k = String(c.addId);
    if (!proposedDrops.has(k)) proposedDrops.set(k, new Set());
    proposedDrops.get(k).add(dk(c.dropId));
  }
  const out = new Map();
  for (const c of proposed) {
    const ex = byAdd.get(String(c.addId)) || [];
    const exact = ex.find((x) => dk(x.dropId) === dk(c.dropId));
    const notes = [];
    let status = "new";
    let matches = [];
    if (exact) {
      matches = [exact];
      if (Number(exact.bid) === Number(c.bid)) status = "same";
      else {
        status = "bid";
        notes.push(`Existing bid of $${Number(exact.bid) || 0} will be updated to $${Number(c.bid) || 0} (cancel and re-push).`);
      }
    } else {
      const orphans = ex.filter((x) => !proposedDrops.get(String(c.addId))?.has(dk(x.dropId)));
      if (orphans.length) {
        status = "drop";
        matches = orphans;
        const who = orphans.map((x) => (x.dropId ? `drop ${nameOf(x.dropId).name}` : "no drop")).join("; ");
        notes.push(`An existing claim for this player (${who}) will be updated (cancel and re-push).`);
      }
    }
    if (c.dropId) {
      const sd = existing.filter((x) => String(x.addId) !== String(c.addId) && x.dropId && String(x.dropId) === String(c.dropId));
      if (sd.length) notes.push(`An existing claim for ${sd.map((x) => nameOf(x.addId).name).join(", ")} already drops ${nameOf(c.dropId).name}.`);
    }
    out.set(c.key, { status, matches: matches.map((x) => ({ txId: x.txId, leg: x.leg ?? null, addId: x.addId, dropId: x.dropId, bid: x.bid })), notes });
  }
  return out;
}

/** Is this claim left out of the push? Identical claims are off unless ticked (plan.dupOn); the rest are on unless unticked. */
export function isOff(c, cmp, unselected = [], dupOn = []) {
  if (cmp.get(c.key)?.status === "same") return !new Set(dupOn).has(c.key);
  return new Set(unselected).has(c.key);
}

/**
 * What a push does. `ordered` = every proposed claim in display order.
 *  - resendAll: the identical claims were put in a different order than they sit in Sleeper -> cancel EVERYTHING queued
 *    and send every identical claim plus every ticked one in the new order.
 *  - otherwise cancel only the queued claims that a ticked claim updates (or an identical one the user ticked) and push the ticked ones.
 * Returns { cancel: [{txId, leg}], push: [claims], resendAll }.
 */
export function planPush(ordered = [], cmp, existing = [], { unselected = [], dupOn = [] } = {}) {
  const same = ordered.filter((c) => cmp.get(c.key)?.status === "same");
  const seq = same.map((c) => String(cmp.get(c.key).matches[0].txId));
  const queued = existing.map((x) => String(x.txId)).filter((id) => seq.includes(id));
  const resendAll = seq.length > 1 && seq.some((id, i) => id !== queued[i]);
  const on = (c) => !isOff(c, cmp, unselected, dupOn);
  if (resendAll) {
    return {
      resendAll: true,
      cancel: existing.map((x) => ({ txId: x.txId, leg: x.leg ?? null })),
      push: ordered.filter((c) => cmp.get(c.key)?.status === "same" || on(c)),
    };
  }
  const push = ordered.filter(on);
  const seen = new Set();
  const cancel = [];
  for (const c of push) {
    for (const m of cmp.get(c.key)?.matches || []) {
      if (seen.has(String(m.txId))) continue;
      seen.add(String(m.txId));
      cancel.push({ txId: m.txId, leg: m.leg ?? null });
    }
  }
  return { resendAll: false, cancel, push };
}

/** Integrate mode: what each queued claim's bid box starts with, and whether the Available page already has a different bid. */
export function integrateRow(x, bids = []) {
  const mine = bids.find((b) => String(b.id) === String(x.addId));
  const differs = mine != null && Number(mine.bid) !== Number(x.bid);
  return { oldBid: Number(x.bid) || 0, availableBid: mine ? Number(mine.bid) : null, differs, prefill: differs ? null : Number(x.bid) || 0 };
}

/**
 * "Confirm updates": tick the drop player of every selected queued claim on Drop candidates and put the claim's bid
 * on its pickup player on Available. `chosen` = [{x, bid}] (bid in dollars). Returns the new plan.
 */
export function applyIntegration(plan, chosen = [], nameOf = (id) => ({ id, name: String(id) }), setBidFn) {
  let drops = plan.drops || [];
  let bids = plan.bids || [];
  for (const { x, bid } of chosen) {
    if (x.dropId) drops = drops.map((d) => (String(d.id) === String(x.dropId) ? { ...d, willing: true } : d));
    const p = nameOf(x.addId);
    bids = setBidFn(bids, { id: String(x.addId), name: p.name, pos: p.pos }, bid);
  }
  return { ...plan, drops, bids, edits: {}, removed: [], order: [], unselected: [], dupOn: [] };
}

/** A fingerprint of the inputs (Available bids + Drop candidates). When it changes, the claims are re-evaluated from fresh. */
export function planSignature(plan) {
  return JSON.stringify([(plan.bids || []).map((b) => [b.id, b.bid]), (plan.drops || []).map((d) => [d.id, d.willing ? 1 : 0])]);
}
export function freshPlan(plan) {
  return { ...plan, edits: {}, removed: [], order: [], unselected: [], dupOn: [] };
}
