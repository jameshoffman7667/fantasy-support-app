# Android app

A Trusted Web Activity: a small Android app that opens https://fantasy.hoffmanhouse.ca
full screen in Chrome's engine, with its own icon, splash screen and notifications.

- Build: the `android` job of `.github/workflows/release.yml` (every release; "Run workflow" rebuilds an existing tag). It signs
  with the key from the repository secrets and attaches `fantasy-support-app-<version>.apk` to the release. See [`../ANDROID_APK.md`](../ANDROID_APK.md).
- Settings you might change: `gradle.properties` (`twaHost`, `twaAppName`, `twaLauncherName`). The package id never changes.
- New logo? `python3 android/tools/make-icons.py` (from the repo root) regenerates the images.

Local build, if you ever want one (Android SDK + JDK 17 installed; only with a keystore you created yourself):
`ANDROID_KEYSTORE_PATH=… ANDROID_KEYSTORE_PASSWORD=… ANDROID_KEY_ALIAS=fantasy ./gradlew assembleRelease -PappVersionCode=… -PappVersionName=…`
→ `app/build/outputs/apk/release/app-release.apk`. Without the keystore variables Gradle produces an unsigned APK, which no phone installs.

Based on the Android project template of Google's Bubblewrap 1.25 (Apache License 2.0).
