Nothing to put here (v4.0).

The Android app's /.well-known/assetlinks.json is served by the server container
(server/androidApp.js; the signing key's fingerprint is built in since v4.19.0, and
ANDROID_APP_SHA256 / ANDROID_APP_PACKAGE can still override it) -- nginx forwards that one path to it
(client/nginx.conf), so a file placed here would be ignored. See ANDROID_APK.md at the repo root.
