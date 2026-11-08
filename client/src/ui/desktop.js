import { useEffect, useState } from "react";

// v4.18.0 (P-5): the desktop layout starts at 1024 px wide. It is planned for a 16:10 screen (about 1440-1600 px wide,
// MAX_DESKTOP_WIDTH); wider screens keep blank sides. Below 1024 px nothing changes from the phone layout.
export const DESKTOP_QUERY = "(min-width: 1024px)";
export const MAX_DESKTOP_WIDTH = 1600;
const matches = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(DESKTOP_QUERY).matches;

export function useDesktop() {
  const [on, setOn] = useState(matches);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const q = window.matchMedia(DESKTOP_QUERY);
    const h = () => setOn(q.matches);
    q.addEventListener?.("change", h);
    h();
    return () => q.removeEventListener?.("change", h);
  }, []);
  return on;
}
