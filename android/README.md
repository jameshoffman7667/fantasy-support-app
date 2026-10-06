# Android app (v3.9)

A Trusted Web Activity: a small Android app that opens https://fantasymanager.hoffmanhouse.ca
full screen in Chrome's engine, with its own icon, splash screen and notifications.

- Build: GitHub → Actions → **Build Android app** (`.github/workflows/android-apk.yml`). It signs
  with your key from the repository secrets and puts `fantasy-manager.apk` on the "Android app" release.
- Setup and install, step by step: [`../ANDROID_APK.md`](../ANDROID_APK.md).
- Settings you might change: `gradle.properties` (`twaHost`, `twaAppName`, `twaLauncherName`).
- New logo? `python3 android/tools/make-icons.py` (from the repo root) regenerates the images.

Local build, if you ever want one (Android SDK + JDK 17 installed):
`ANDROID_KEYSTORE_PATH=… ANDROID_KEYSTORE_PASSWORD=… ./gradlew assembleRelease`
→ `app/build/outputs/apk/release/app-release.apk`. Use a versionCode above the last
workflow run (`-PappVersionCode=…`), or Android won't install it over the workflow's build.

Based on the Android project template of Google's Bubblewrap 1.25 (Apache License 2.0).
