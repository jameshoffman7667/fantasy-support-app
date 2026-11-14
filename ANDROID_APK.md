# Android app (APK)

The Android app is a Trusted Web Activity: a thin shell that opens https://fantasy.hoffmanhouse.ca full screen. Since v4.19.0 it is built by the `android` job of `.github/workflows/release.yml` on every release and published to James's F-Droid repo; there is nothing to set up per release.

- Package id `ca.hoffmanhouse.fantasymanager` (never changes), key alias `fantasy`, APK `fantasy-support-app-<version>.apk` on the `vX.Y.Z` GitHub release.
- versionName = the release version; versionCode = MAJOR*100000000 + MINOR*10000 + PATCH (`scripts/android-version.js`).
- Needs the four repository secrets `ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. Without them the job skips (green) and names the missing ones. It never builds a debug-signed APK.
- `/.well-known/assetlinks.json` is served by the app itself (`server/androidApp.js`); the signing certificate's fingerprint is built in. The job fails if the APK's certificate is not listed there.
- Rebuild a failed or wrong APK nobody has installed (no new release): Actions → release → Run workflow (tag `vX.Y.Z`, overwrite off), or
  `gh api -X POST repos/jameshoffman7667/fantasy-support-app/actions/workflows/release.yml/dispatches -f ref=main -f 'inputs[tag]=vX.Y.Z' -f 'inputs[overwrite]=false'`.
  It refuses to replace an APK already on the release unless overwrite is on. The versionCode does not change on a rebuild, so a problem already on a phone needs a patch release.
- If the app crashes on a phone, get a logcat first (`adb logcat -b crash`) before changing anything.

Everything else (flow, limits, Back button behaviour) is in the Android section of [`docs/functional-spec.md`](docs/functional-spec.md). The project itself is in [`android/`](android/README.md).
