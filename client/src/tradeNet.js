// v4.15.0 (P-25): the value of an editable trade. `lookup(id)` → { value, dyn } (value = dynasty value in dynasty
// leagues, rest-of-season points in redraft). Net leans +10% when built; edits show what they do to it.
export function sideTotals(ids, lookup) {
  let value = 0;
  let dyn = 0;
  let dynKnown = false;
  for (const id of ids) {
    const p = lookup(id);
    if (!p) continue;
    value += Number(p.value) || 0;
    if (p.dyn != null) { dyn += Number(p.dyn) || 0; dynKnown = true; }
  }
  return { value: Math.round(value * 10) / 10, dyn: dynKnown ? Math.round(dyn) : null };
}
export function tradeNet(getIds, giveIds, lookup) {
  const g = sideTotals(getIds, lookup);
  const v = sideTotals(giveIds, lookup);
  const net = Math.round((g.value - v.value) * 10) / 10;
  const pct = v.value > 0 ? Math.round(((g.value - v.value) / v.value) * 1000) / 10 : null;
  const dynNet = g.dyn != null && v.dyn != null ? g.dyn - v.dyn : null;
  return { get: g, give: v, net, pct, dynNet };
}
