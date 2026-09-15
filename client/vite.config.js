import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // The client never talks to Sleeper or FantasyPros directly — every
      // data call goes to our own backend, which is the only place the
      // FantasyPros key lives.
      "/api": "http://localhost:4000",
    },
  },
});
