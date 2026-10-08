import { useState } from "react";
import { Modal } from "./common.jsx";
import { C, fmtWhen } from "./theme.js";

/**
 * v4.3: start / sit signals from the article research (Gemini): a green traffic light = strong start, a yield sign =
 * mixed opinions, a stop sign = strong sit. Drawn as small inline SVGs (no icon font has all three).
 */
export const VERDICT = {
  start: { label: "Start", long: "Strong start", color: "#3FAE5A" },
  mixed: { label: "Mixed", long: "Mixed opinions", color: "#D9A521" },
  sit: { label: "Sit", long: "Strong sit", color: "#D6533B" },
};

export function StartSitIcon({ verdict, size = 18 }) {
  if (verdict === "start")
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" data-icon="traffic-light">
        <rect x="7" y="1.5" width="10" height="21" rx="3" fill="#20262A" stroke="#5B6770" strokeWidth="1" />
        <circle cx="12" cy="6" r="2.4" fill="#4A2A26" />
        <circle cx="12" cy="12" r="2.4" fill="#4A4226" />
        <circle cx="12" cy="18" r="2.6" fill="#3FDB6A" />
      </svg>
    );
  if (verdict === "mixed")
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" data-icon="yield">
        <path d="M2 3.5 H22 L12 21.5 Z" fill="#D6533B" stroke="#D6533B" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M6.8 6.3 H17.2 L12 15.7 Z" fill="#FFFFFF" />
      </svg>
    );
  if (verdict === "sit")
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" data-icon="stop">
        <polygon points="8,1.5 16,1.5 22.5,8 22.5,16 16,22.5 8,22.5 1.5,16 1.5,8" fill="#D6533B" stroke="#FFFFFF" strokeWidth="1.2" />
        <text x="12" y="14.6" textAnchor="middle" fontSize="6.4" fontWeight="700" fill="#FFFFFF" fontFamily="Arial, sans-serif">STOP</text>
      </svg>
    );
  return null;
}

/** The icon as a button (under the score); tapping opens the article summary. */
export function StartSitButton({ player }) {
  const [open, setOpen] = useState(false);
  const ss = player?.startSit;
  if (!ss?.verdict) return null;
  const v = VERDICT[ss.verdict];
  return (
    <>
      <button type="button" onClick={(e) => (e.stopPropagation(), setOpen(true))} className="mt-1 inline-flex" title={`${v.long} — tap for the article summary`} aria-label={`${v.long} for ${player.name}: open the article summary`} data-start-sit={ss.verdict}>
        <StartSitIcon verdict={ss.verdict} />
      </button>
      {open && (
        <Modal title={`${player.name} — start / sit`} onClose={() => setOpen(false)}>
          <div className="space-y-2.5 text-sm" data-start-sit-modal>
            <div className="flex items-center gap-2">
              <StartSitIcon verdict={ss.verdict} size={26} />
              <span style={{ color: v.color }} className="font-semibold">{v.long}</span>
              <span style={{ color: C.textMuted }} className="text-xs">· {ss.start} say start, {ss.sit} say sit</span>
            </div>
            {ss.summary && <div style={{ color: C.text }} className="leading-snug">{ss.summary}</div>}
            {ss.sources?.length > 0 && <div style={{ color: C.textMuted }} className="text-xs">Sources: {ss.sources.join(", ")}</div>}
            <div style={{ color: C.textFaint }} className="text-[11px]">AI summary (Gemini) of this week's start/sit articles, rankings columns and posts{ss.at ? ` · ${fmtWhen(ss.at)}` : ""}. It reads the coverage; it doesn't make the call for you.</div>
          </div>
        </Modal>
      )}
    </>
  );
}
