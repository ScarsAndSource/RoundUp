package com.roundup.alarm;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local (in-app) plugins must be registered BEFORE super.onCreate()
        registerPlugin(RoundupAlarmPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
