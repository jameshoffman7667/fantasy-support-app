// v4.19.0: Android Back (and the browser's Back) for pop-ups and menus.
//
// A Trusted Web Activity has no Back button of its own: the Android Back gesture is history.back() on the
// page, and when there is no earlier history entry the app closes. The screens already push one history entry
// per navigation (App.jsx `navigate`). Pop-ups and drop-down menus did not, so Back left the screen behind
// them (or closed the app from the dashboard) instead of just closing the pop-up.
//
// A "layer" is an open pop-up or menu. Opening one pushes a history entry marked with its depth; Back then
// pops that entry and `handlePop` closes the layer instead of changing the screen. Closing a layer from the
// page (its X, the dim background, a choice in the menu) removes its entry again with history.go(-n), and the
// popstate that causes is swallowed (`skip`). Navigating to another screen while a layer is open turns the
// layer's entry into the new screen's entry (see `navigateWithLayers`), so Back never lands on a stale layer.
import { useEffect, useRef } from "react";

let stack = []; // open layers, bottom to top: { close }
let skip = 0; // popstate events caused by our own history.go()

const stateOf = () => window.history.state || {};

/** Open a layer: push a history entry marked with the new depth. `close` is called when Back pops it. */
export function openLayer(close) {
  const layer = { close };
  stack.push(layer);
  window.history.pushState({ ...stateOf(), __layer: stack.length }, "");
  return layer;
}

/** Close a layer (and any above it) from the page: remove its history entries. No-op if Back already did. */
export function closeLayer(layer) {
  const i = stack.indexOf(layer);
  if (i < 0) return;
  const removed = stack.splice(i);
  skip += 1;
  window.history.go(-removed.length);
}

/**
 * Call first in a popstate listener. True when the event belonged to a layer (our own go(), or Back
 * popping a layer, whose close callbacks run here), so the caller must not change the screen.
 */
export function handlePop(e) {
  if (skip > 0) {
    skip -= 1;
    return true;
  }
  const depth = (e && e.state && e.state.__layer) || 0;
  if (stack.length > depth) {
    const removed = stack.splice(depth);
    for (const l of removed.reverse()) {
      try {
        l.close();
      } catch {
        // a layer that fails to close must not block the others
      }
    }
    return true;
  }
  return false;
}

/**
 * Navigate to a new screen. With layers open, the topmost layer's entry becomes the new screen's entry
 * (history: [A, A+layer] -> [A, B]) and the layers are told to close; otherwise a normal push or replace.
 */
export function navigateWithLayers(newView, { replace = false } = {}) {
  if (stack.length) {
    const removed = stack.splice(0);
    window.history.replaceState(newView, "");
    for (const l of removed.reverse()) {
      try {
        l.close();
      } catch {
        // ignore
      }
    }
    return;
  }
  if (replace) window.history.replaceState(newView, "");
  else window.history.pushState(newView, "");
}

/** Test helpers. */
export const layerDepth = () => stack.length;
export function resetLayers() {
  stack = [];
  skip = 0;
}

/** While `open` is true, Back closes this pop-up/menu by calling `onClose`. */
export function useBackLayer(open, onClose) {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    if (!open) return undefined;
    const layer = openLayer(() => ref.current && ref.current());
    return () => closeLayer(layer);
  }, [open]);
}
