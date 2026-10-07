Nothing to put here any more (v4.0).

The Android app's /.well-known/assetlinks.json is now served by the server
container from its ANDROID_APP_SHA256 (and optional ANDROID_APP_PACKAGE)
environment variables — nginx forwards that one path to it (client/nginx.conf),
so a file placed here would be ignored. See ANDROID_APK.md at the repo root.
