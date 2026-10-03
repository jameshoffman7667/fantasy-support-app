import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Registering this is one of Chrome's actual install criteria (alongside
// the manifest link in index.html and HTTPS) — without it, the "Install
// app" option won't appear even with a perfectly valid manifest. Skipped
// entirely on localhost-over-http dev if the browser doesn't consider it
// a secure context, but that's fine — installability only matters for
// the real deployed instance anyway.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("Service worker registration failed (app still works, just not installable):", err);
    });
  });
}

