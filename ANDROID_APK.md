# Creating an Android APK

The app is now a real PWA (manifest + service worker, from the "installable in Chrome" work). The standard, legitimate way to turn a PWA into an Android app — no separate native codebase, no React Native rewrite — is a **Trusted Web Activity (TWA)**: a thin native wrapper that just opens your PWA full-screen, with no browser chrome. This is the same mechanism Google itself recommends and uses for many PWA-to-Play-Store apps.

Two ways to build one. Do either — not both.

---

## Prerequisite (applies to both options): a real public HTTPS URL

TWAs verify their connection to your site via **Digital Asset Links**, which requires:
- A real domain (not `localhost`, not a bare IP)
- Valid HTTPS (a self-signed cert won't pass verification)

If your Portainer deployment is currently plain HTTP on a LAN IP, you'll need a reverse proxy with a real certificate in front of it first — Caddy or Traefik with Let's Encrypt, or a Cloudflare Tunnel, are the common low-effort options for a home-server setup like this one. That's a prerequisite step, not part of the APK build itself.

---

## Option A — PWABuilder (easiest; no Android Studio, no CLI)

1. Deploy the app (with the manifest/service worker changes) behind your real HTTPS domain.
2. Go to **pwabuilder.com** and enter your app's URL (e.g. `https://fantasy.yourdomain.com`).
3. PWABuilder reads `manifest.webmanifest` automatically and shows a report — it should score well already, since the manifest here includes all the required fields (name, icons at 192/512, `display: standalone`, start_url).
4. Click **Package for Stores → Android**. Choose:
   - **Package ID**: reverse-domain style, e.g. `com.yourdomain.fantasymanager`
   - **Signing key**: let PWABuilder generate one for you (fine for personal use — save the downloaded `.pfx`/keystore somewhere safe; you'll need the *same* key for every future update, or Android will refuse to install the new version over the old one)
5. Download the generated package. You'll get an APK (or AAB) plus a `assetlinks.json` snippet and your key's SHA-256 fingerprint.
6. **Publish the asset links file** so Android can verify your app owns the domain:
   - Save the JSON PWABuilder gives you as `client/public/.well-known/assetlinks.json` in this repo (the folder already exists, empty, waiting for this — see below)
   - Rebuild/redeploy the client container — since it's under `public/`, Vite copies it to the site root automatically, and it'll be reachable at `https://yourdomain.com/.well-known/assetlinks.json`
7. Install the APK on your phone: transfer it and open it (you'll need to allow "install unknown apps" for whichever app you used to open it), or `adb install app-release-signed.apk` over USB with developer mode on.

This is the right choice if you just want a working icon on your home screen without setting up Android build tooling locally.

---

## Option B — Bubblewrap CLI (Google's official tool; more control, scriptable/repeatable)

Better if you want to rebuild the APK as part of a normal workflow rather than re-uploading to a website each time.

1. **Prerequisites**: Node.js (already have it for this project), a JDK (11+), and Android SDK command-line tools. Bubblewrap can auto-download the SDK/JDK on first run if you don't have them.
2. Install:
   ```bash
   npm install -g @bubblewrap/cli
   ```
3. Initialize from your live manifest:
   ```bash
   bubblewrap init --manifest=https://yourdomain.com/manifest.webmanifest
   ```
   It'll prompt for package ID, app name, signing key (create a new one and **back it up** — same "you need it for every future update" rule as Option A), and confirm the icon/theme-color it read from the manifest.
4. Build:
   ```bash
   bubblewrap build
   ```
   This produces a signed APK (and AAB) in the project directory, and prints the SHA-256 fingerprint you need for `assetlinks.json`.
5. Same asset-links step as Option A: put the JSON at `client/public/.well-known/assetlinks.json`, redeploy.
6. Install:
   ```bash
   adb install app-release-signed.apk
   ```

---

## What `assetlinks.json` should look like

Both tools generate the exact content for you, but for reference, the shape is:

```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "com.yourdomain.fantasymanager",
    "sha256_cert_fingerprints": ["YOUR:KEY:FINGERPRINT:IN:THIS:FORMAT"]
  }
}]
```

Use the exact `package_name` and fingerprint your chosen tool gives you — don't hand-write the fingerprint, copy it.

---

## Updating the app later

- **The web app itself** (React/server changes) updates the normal way — redeploy the containers. Anyone with the TWA installed gets the update automatically next time they open it, same as any PWA, since the APK is just a wrapper that loads your live site.
- **The APK itself** only needs rebuilding if you change the manifest (name, icons, theme color) or want a new Android version code — not for ordinary app changes.

## Play Store note (optional, not needed for personal use)

Everything above gives you a side-loadable APK for your own device(s) — no Play Store account needed. If you ever want it listed in the Play Store instead of side-loaded, you'd additionally need: the AAB format (both tools produce this too), a Google Play Console developer account (one-time $25 fee), and to meet Play's standard content/privacy policies. Given this is a personal fantasy-football tool tied to your own Sleeper/FantasyPros accounts, side-loading is almost certainly the right call — nothing above requires the Play Store step.
