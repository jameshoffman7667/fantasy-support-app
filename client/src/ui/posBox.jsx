import { FLEX_ELIGIBLE } from "../lineup.js";
import { POS_COLOR } from "./theme.js";

/* v4.8 — the Roster page's position box (Sleeper colours), shared so the player card can use it too. */
// Sleeper-style slot colours: positions from POS_COLOR, bench / IR / taxi their own.
const SLOT_EXTRA = { BN: "#5E7570", IR: "#D6533B", TAXI: "#A08BE0" };
const slotColor = (slot) => POS_COLOR[slot] || SLOT_EXTRA[slot] || POS_COLOR.FLEX;
// v4.5: a flex slot is shown as vertical bands in the colours of the positions that can play it.
const flexBands = (label) => (FLEX_ELIGIBLE[label] ? FLEX_ELIGIBLE[label].map((p) => POS_COLOR[p]).filter(Boolean) : null);
const bandBackground = (label) => {
  const bands = flexBands(label);
  if (!bands || bands.length < 2) return null;
  const w = 100 / bands.length;
  return `linear-gradient(to right, ${bands.map((c, i) => `${c} ${i * w}%, ${c} ${(i + 1) * w}%`).join(", ")})`;
};
export function PosBox({ label, small = false }) {
  const bands = bandBackground(label);
  return (
    <span
      style={{ background: bands || slotColor(label), color: "#0E1416", fontFamily: "Oswald, sans-serif", letterSpacing: "0.02em", textShadow: bands ? "0 0 3px rgba(255,255,255,0.75), 0 0 1px rgba(255,255,255,0.9)" : undefined }}
      className={`inline-flex items-center justify-center rounded font-bold shrink-0 ${small ? "text-[9px] w-9 h-5" : "text-[11px] w-11 h-7"}`}
      data-pos-box={label}
      {...(bands ? { "data-flex-bands": flexBands(label).length } : {})}
    >
      {label}
    </span>
  );
}

