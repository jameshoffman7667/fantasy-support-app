# Fantasy Manager as an Android app (APK)

From v3.9 the repo contains a complete Android app project (`android/`) and a GitHub workflow that builds it into a signed APK for you. You don't need Android Studio or any Android tools on your own computer.

**What you get:** an app with its own launcher icon, splash screen and name ("Fantasy Mgr" under the icon). It opens full screen, with no address bar. Push alerts appear as the app's own notifications. Links to `fantasymanager.hoffmanhouse.ca` open in the app.

**How it works:** the app is a *Trusted Web Activity* (TWA), Google's supported way to ship a web app as an Android app. It's a small native shell that opens your live site in Chrome's engine. That means:
- **Web app updates never need a new APK.** Redeploy the containers as usual, and the app shows the new version the next time it opens.
- You rebuild the APK only to change the icon, the name or the site address.
- It shares Chrome's login. If you're logged in to the site in Chrome on the phone, you're logged in in the app.
- Chrome must be installed on the phone, which it is on almost every Android phone.

---

## What you need (once)

- The site at `https://fantasymanager.hoffmanhouse.ca` with a valid certificate. Caddy already does this.
- Your GitHub repo, the same one that builds the Docker images.
- Somewhere to run one Docker command (your server, over SSH), *or* any computer with Java installed. This is only to create the signing key.
- An Android phone (Android 7 or newer).

The whole setup takes about 20 minutes. Steps 1–3 are one-time; after that, a new APK is one click (step 4).

---

## Step 1 — Create the app's signing key (one time)

Android only installs an update over an existing app if it's signed with the **same key**, so you create one key and keep it forever.

On your server (SSH), in a folder of your choice:

```bash
mkdir -p ~/fantasy-android-key && cd ~/fantasy-android-key
docker run --rm -it -v "$PWD":/keys -w /keys eclipse-temurin:17-jdk \
  keytool -genkeypair -keystore fantasy-manager.keystore -alias fantasy \
  -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Fantasy Manager"
```

- It asks for a **keystore password** twice. Choose a long one and save it in your password manager.
- The result is the file `fantasy-manager.keystore` in that folder.

Now turn the key into one line of text for GitHub:

```bash
base64 -w0 fantasy-manager.keystore > fantasy-manager.keystore.b64
cat fantasy-manager.keystore.b64
```

**Back up `fantasy-manager.keystore` and its password** somewhere safe that isn't the git repo (the repo's `.gitignore` already refuses key files, just in case). If you lose the key, you can still build a new app, but you'll have to uninstall the old one first.

<details>
<summary>On Windows or a Mac instead (needs Java installed)</summary>

Run the same `keytool -genkeypair …` line, without the `docker run … eclipse-temurin:17-jdk` part, in a terminal. Then:

- Mac: `base64 -i fantasy-manager.keystore | tr -d '\n' > fantasy-manager.keystore.b64`
- Windows (PowerShell): `[Convert]::ToBase64String([IO.File]::ReadAllBytes("$PWD\fantasy-manager.keystore")) | Set-Content -NoNewline fantasy-manager.keystore.b64`
</details>

## Step 2 — Give the key to GitHub (one time)

In your repo on GitHub: **Settings → Secrets and variables → Actions → Secrets → New repository secret**. Add two secrets:

| Name | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | the whole content of `fantasy-manager.keystore.b64` (one long line) |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore password from step 1 |

Only if you changed the commands above: add `ANDROID_KEY_ALIAS` if you used an alias other than `fantasy`. `ANDROID_KEY_PASSWORD` is only needed for an older-format key with its own password.

Then delete the `.b64` file: `rm fantasy-manager.keystore.b64`. Keep the `.keystore` backup.

*(Optional)* If the site ever moves to another address, set a repository **variable** (the Variables tab, next to Secrets) `ANDROID_HOST` = the new host name, e.g. `fantasy.example.com`. The default is in `android/gradle.properties`.

## Step 3 — Push v3.9

Commit and push this version to `main` as usual:
- The Docker workflow builds the new images. The server now answers `/.well-known/assetlinks.json` (the file Android checks; see step 5).
- **Redeploy the stack in Portainer** with re-pull turned on, so the v3.9 images run.

(The push also starts the Android workflow. If you push before step 2, it just leaves a yellow warning and builds nothing.)

## Step 4 — Build the APK

GitHub → **Actions** → **Build Android app** → **Run workflow** → branch `main` → **Run workflow**.

The first build takes about 5–8 minutes; later builds are faster. When it's green:
- The APK is attached to a release called **Android app**, as `fantasy-manager.apk` (Code tab → Releases on the right). It's also kept for 30 days as an artifact of the run.
- Open the run and scroll to the summary. It shows two lines for step 5, like:

```
ANDROID_APP_PACKAGE=ca.hoffmanhouse.fantasymanager
ANDROID_APP_SHA256=03:2A:04:…:27:62
```

## Step 5 — Let the site vouch for the app (one time)

Android shows the app full screen only when the site confirms the app is its own. The server builds that confirmation from an environment variable:

1. Portainer → **Stacks** → your fantasy-manager stack → **Editor** → **Environment variables** → **Add an environment variable**:
   - name `ANDROID_APP_SHA256`, value: the fingerprint from the run's summary (`03:2A:…`). Pasting the whole `SHA256: …` line from keytool also works.
   - `ANDROID_APP_PACKAGE` isn't needed; it defaults to `ca.hoffmanhouse.fantasymanager`.
2. **Update the stack.**
3. Check in any browser: <https://fantasymanager.hoffmanhouse.ca/.well-known/assetlinks.json>. It should show a short JSON with `ca.hoffmanhouse.fantasymanager` and your fingerprint. `https://fantasymanager.hoffmanhouse.ca/api/health` also shows `"androidAppLinks": true`.
4. *(Optional)* Google's own check: <https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://fantasymanager.hoffmanhouse.ca&relation=delegate_permission/common.handle_all_urls> should list the same package and fingerprint.

This value only changes if you make a new signing key. Do this step **before** installing (step 6): Android also checks it when the app is installed, to let links to the site open in the app.

## Step 6 — Install it on your phone

1. On the phone, open GitHub in Chrome (signed in, if the repo is private) → your repo → **Releases** → **Android app** → tap **fantasy-manager.apk** to download it.
2. Open the download. The first time, Android asks to allow Chrome to install apps ("Install unknown apps"). Allow it, go back, then tap **Install**.
3. Google Play Protect may say it doesn't recognise the app, because it isn't from the Play Store. Choose **More details → Install anyway**. It's your own app.
4. If you earlier added the site to the home screen with Chrome's "Install app" / "Add to Home screen", remove that old icon so you don't have two.

*(Alternative from a computer: download the artifact zip from the run, unzip it, and run `adb install fantasy-manager.apk` with the phone connected by USB and USB debugging on.)*

## Step 7 — First launch

- You'll see the splash screen (the football logo on the app's dark background), then the app. If Chrome on this phone is already logged in to the site, you're logged in; otherwise log in as usual.
- **Notifications:** user menu (your photo, top left) → **Enable alerts**. Android asks for permission to show notifications: allow it. Alerts then arrive as Fantasy Manager notifications. This needs the server's VAPID keys, the same as alerts in the browser.
- There should be **no address bar** at the top. If there is one, see the troubleshooting below. A one-time "Running in Chrome" note at the bottom is normal.

---

## Updating

| What changed | What to do |
|---|---|
| The web app (anything in `server/` or `client/`) | Nothing. Redeploy the containers as always; the app picks it up on next launch. |
| The app's name, icon or host (`android/`) | Push the change (the Android workflow runs by itself) or press **Run workflow**. Install the new `fantasy-manager.apk` over the old one; your login and settings are kept. |
| New phone | Install the same APK from the release. |

Pushes that only touch `android/` no longer rebuild the Docker images.

## Troubleshooting

| Problem | Fix |
|---|---|
| An address bar / site name shows at the top of the app | The site isn't vouching for the app yet. Check the assetlinks link in step 5: it must show **exactly** the fingerprint from the latest workflow summary, and the page must load without a login or a redirect. Then close the app fully (swipe it away) and reopen it. The fix can take a little while to be noticed; if the bar stays, uninstall and reinstall the app. |
| "App not installed" or "conflicts with an existing package" | A copy signed with a different key is installed, for example one made with PWABuilder. Uninstall it, then install again. |
| The workflow fails at "Decode and check the keystore" | The password secret doesn't match the key, or the alias isn't `fantasy` (set `ANDROID_KEY_ALIAS`). Re-check step 2. |
| The workflow fails at "Check the signing secrets" | The two secrets from step 2 are missing (a manual run fails; a push only warns). |
| No notifications | Phone Settings → Apps → Fantasy Manager → Notifications must be on, and **Enable alerts** must have been done inside the app. Alerts also need the server's VAPID keys. |
| The app opens in a browser-looking tab | Chrome is missing or disabled on the phone; the app falls back to a Chrome "custom tab". Install or enable Chrome. |
| Downloads (best ball CSV) or uploads (charter files) | They work like in Chrome. Downloaded files land in the phone's Downloads. |

## Plan B — without GitHub Actions (PWABuilder)

If you'd rather not use the workflow, <https://www.pwabuilder.com> can build an APK from the live site:
1. Enter `https://fantasymanager.hoffmanhouse.ca` → **Package for stores** → **Android**.
2. Package ID: `ca.hoffmanhouse.fantasymanager`. Signing key: let PWABuilder create one, and keep the downloaded key file and passwords.
3. Download the zip. It holds the APK and a file `assetlinks.json` with a fingerprint.
4. In Portainer, set `ANDROID_APP_SHA256` to that fingerprint (step 5). Then install the APK (step 6).

Its key is different from the workflow's, so stick with one method. To switch, uninstall the app first.

## What's in `android/`

| Path | What it is |
|---|---|
| `android/gradle.properties` | The settings you might change: `twaHost` (the site), `twaAppName`, `twaLauncherName`. |
| `android/app/build.gradle` | Build script: colours, splash, notification delegation, the asset-link statement, release signing from the workflow's secrets. |
| `android/app/src/main/AndroidManifest.xml` | The app's activities and services (from Google's Bubblewrap template). |
| `android/app/src/main/java/…` | Three small classes from the same template. |
| `android/app/src/main/res/` | Launcher icon (incl. an Android 13 themed-icon layer), splash logo, notification icon. Rebuild them with `python3 android/tools/make-icons.py` if the logo changes. |
| `.github/workflows/android-apk.yml` | Builds, signs, and publishes the APK; prints the server settings. |
| `server/androidApp.js` | Serves `/.well-known/assetlinks.json` from `ANDROID_APP_SHA256` / `ANDROID_APP_PACKAGE`. |

**Don't change** the package name (`ca.hoffmanhouse.fantasymanager`) once the app is installed. Android treats a different package as a different app.

The project is based on the Android template of Google's Bubblewrap 1.25 (Apache License 2.0) and uses Google's `androidbrowserhelper` 2.6.2 library. It couldn't be test-built here (no Android build tools in Claude's sandbox), so the first run of the workflow is the real test. If it fails, the log of the failing step says why.
