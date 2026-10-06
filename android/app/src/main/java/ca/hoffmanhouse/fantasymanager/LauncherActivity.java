/*
 * Fantasy Manager Android app (v3.9).
 *
 * Based on the Bubblewrap 1.25 template (https://github.com/GoogleChromeLabs/bubblewrap),
 * Copyright 2019 Google Inc., Licensed under the Apache License, Version 2.0.
 */
package ca.hoffmanhouse.fantasymanager;

import android.content.pm.ActivityInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;

/** Opens the web app (android/gradle.properties → twaHost) as a Trusted Web Activity. */
public class LauncherActivity
        extends com.google.androidbrowserhelper.trusted.LauncherActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Setting an orientation crashes the app due to the transparent background on Android 8.0
        // Oreo and below. We only set the orientation on Oreo and above. This only affects the
        // splash screen and Chrome will still respect the orientation.
        // See https://github.com/GoogleChromeLabs/bubblewrap/issues/496 for details.
        if (Build.VERSION.SDK_INT > Build.VERSION_CODES.O) {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
        } else {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        }
    }

    @Override
    protected Uri getLaunchingUrl() {
        // The URL the app opens: the launcher's start URL, or the site link that launched it.
        return super.getLaunchingUrl();
    }
}
