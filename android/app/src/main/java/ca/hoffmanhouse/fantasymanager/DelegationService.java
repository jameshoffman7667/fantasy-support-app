/*
 * Fantasy Manager Android app (v4.0).
 *
 * Based on the Bubblewrap 1.25 template (https://github.com/GoogleChromeLabs/bubblewrap),
 * Copyright 2019 Google Inc., Licensed under the Apache License, Version 2.0.
 */
package ca.hoffmanhouse.fantasymanager;

/**
 * Receives the web app's notifications from Chrome (notification delegation) so they show as this
 * app's notifications, and asks for Android 13+'s notification permission when the site requests it.
 */
public class DelegationService extends
        com.google.androidbrowserhelper.trusted.DelegationService {
    @Override
    public void onCreate() {
        super.onCreate();
    }
}
