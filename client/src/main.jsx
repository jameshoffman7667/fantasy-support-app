import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Registering this is one of Chrome's actual install criteria (alongside the manifest link in index.html and
// HTTPS). v4.12: a new worker waits instead of taking over; an "Update available" bar lets the person reload when
// they choose (never in the middle of a form), and the page reloads on a controller change only if it already
// had a controller, so the very first install doesn't wipe what someone has just typed.
function showUpdateBar(reg) {
  if (document.getElementById("sw-update-bar")) return;
  const bar = document.createElement("div");
  bar.id = "sw-update-bar";
  bar.setAttribute("role", "status");
  Object.assign(bar.style, {
    position: "fixed", left: "12px", right: "12px", top: "calc(12px + env(safe-area-inset-top))", zIndex: "9999",
    display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", padding: "10px 12px",
    borderRadius: "6px", background: "#212C2E", border: "1px solid #2B3A3D", color: "#EDF3F1", fontSize: "13px",
    fontFamily: "Inter, sans-serif", maxWidth: "32rem", margin: "0 auto",
  });
  const text = document.createElement("span");
  text.textContent = "Update available";
  const reload = document.createElement("button");
  reload.textContent = "Reload";
  const later = document.createElement("button");
  later.textContent = "Later";
  for (const b of [reload, later]) {
    Object.assign(b.style, { minHeight: "44px", minWidth: "44px", padding: "0 12px", borderRadius: "6px", border: "0", color: "#EDF3F1", background: b === reload ? "#4A8FC2" : "transparent", fontSize: "13px" });
  }
  reload.addEventListener("click", () => reg.waiting?.postMessage({ type: "SKIP_WAITING" }));
  later.addEventListener("click", () => bar.remove());
  const actions = document.createElement("span");
  actions.append(later, reload);
  bar.append(text, actions);
  document.body.appendChild(bar);
}

// Keep the browser's install prompt so Account can offer an "Install app" button.
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  window.__installPrompt = e;
  window.dispatchEvent(new Event("install-prompt-ready"));
});
window.addEventListener("appinstalled", () => {
  window.__installPrompt = null;
  window.dispatchEvent(new Event("install-prompt-ready"));
});

if ("serviceWorker" in navigator) {
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloading) return;
    reloading = true;
    window.location.reload();
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").then((reg) => {
      if (reg.waiting && navigator.serviceWorker.controller) showUpdateBar(reg);
      reg.addEventListener("updatefound", () => {
        const w = reg.installing;
        w?.addEventListener("statechange", () => {
          if (w.state === "installed" && navigator.serviceWorker.controller) showUpdateBar(reg);
        });
      });
      // Look for a new version whenever the app comes back to the foreground.
      document.addEventListener("visibilitychange", () => { if (!document.hidden) reg.update().catch(() => {}); });
    }).catch((err) => {
      console.warn("Service worker registration failed (app still works, just not installable):", err);
    });
  });
}
